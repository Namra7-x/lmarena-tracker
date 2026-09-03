#!/usr/bin/env python3
"""
LM Arena (arena.ai) Model Tracker - Ground-Up Rebuild

Monitors Arena model metadata every minute and sends clean, high-priority
Telegram alerts when genuine changes occur:
- 🆕 Brand new models
- 🕵️ Hidden / stealth test models
- 🧬 New variants of existing models
- ✏️ Name / display-name / model-name updates
- 🏢 Organization updates
- 🏭 Provider updates
- ⚡ Capability updates (input & output modalities)
- 🆔 ID rotations (with smart multi-pass identity pairing)
- 📊 Rank updates (when TRACK_RANK=true)
- ❌ Genuine model removals

Engineered for 1-minute execution intervals with:
- Modality health validation (prevents false alerts on partial SSR drops)
- In-memory auto-retry on transient backend dropouts
- Stable identity-based batch confirmation for large churn (>20 models)
- Anti-flapping snapshot protection
- Rich, clean Telegram HTML formatting with smart chunking
"""

from __future__ import annotations

import datetime
import hashlib
import html as _html
import json
import os
import random
import re
import time
from typing import Any, Dict, List, Optional, Set, Tuple

import requests

# ==============================================================================
# Configuration
# ==============================================================================
ARENA_URL = "https://arena.ai/"
SNAPSHOT_FILE = "snapshot.json"
ALERT_STATE_FILE = ".arena_alert_state.json"

TELEGRAM_TOKEN = os.environ.get("TELEGRAM_TOKEN", "").strip()
TELEGRAM_CHAT_ID = os.environ.get("TELEGRAM_CHAT_ID", "").strip()
TRACK_RANK = os.environ.get("TRACK_RANK", "false").lower() == "true"

MAX_TELEGRAM_LEN = 4000       # Telegram hard limit is 4096
SECTION_LIMIT = 20            # Limit per section in Telegram alerts
UNRANKED = 9007199254740991   # JS Number.MAX_SAFE_INTEGER

# Thresholds for large change confirmation & modality collapse
LARGE_BATCH_THRESHOLD = 20    # 20+ added/removed models require confirmation
MIN_MODALITY_DROP_RATIO = 0.25 # Modality dropping below 25% is treated as SSR collapse
MODALITY_MIN_MODELS = 15      # Minimum models in old snapshot to check for collapse

TRACKED_FIELDS = [
    "publicName",
    "displayName",
    "name",
    "organization",
    "provider",
    "userSelectable",
]

FIELD_LABELS = {
    "publicName": "Public name",
    "displayName": "Display name",
    "name": "Name",
    "organization": "Organization",
    "provider": "Provider",
    "userSelectable": "User selectable",
}

# Modality normalizer
MODALITY_NORMALIZER = {
    "text": "chat",
    "chat": "chat",
    "web": "webdev",
    "webdev": "webdev",
    "image": "image",
    "video": "video",
    "search": "search",
}


# ==============================================================================
# Model Normalization & Capability Helpers
# ==============================================================================
def get_model_modalities(model: Dict[str, Any]) -> Set[str]:
    """Return set of normalized modalities for a model (chat, webdev, image, video, search)."""
    mods = set()
    # 1. Output capabilities
    caps = (model.get("capabilities") or {}).get("outputCapabilities") or {}
    for k, v in caps.items():
        if v:
            norm = MODALITY_NORMALIZER.get(k.lower(), k.lower())
            mods.add(norm)
    # 2. Modality ranks
    for k in (model.get("rankByModality") or {}).keys():
        norm = MODALITY_NORMALIZER.get(k.lower(), k.lower())
        mods.add(norm)
    return mods


def count_modalities(models: Dict[str, Dict[str, Any]]) -> Dict[str, int]:
    """Count active models in each canonical modality."""
    counts: Dict[str, int] = {}
    for m in models.values():
        for mod in get_model_modalities(m):
            counts[mod] = counts.get(mod, 0) + 1
    return counts


def flatten_caps(model: Dict[str, Any]) -> Set[str]:
    """Extract flattened input and output capabilities as sorted strings."""
    caps = model.get("capabilities") or {}
    result = set()
    input_caps = caps.get("inputCapabilities") or {}
    for k, v in input_caps.items():
        if v:
            result.add(f"in:{k}")
    output_caps = caps.get("outputCapabilities") or {}
    for k, v in output_caps.items():
        if v:
            result.add(f"out:{k}")
    return result


def esc(val: Any) -> str:
    """Escape special characters for Telegram HTML mode."""
    if val is None:
        return ""
    return _html.escape(str(val), quote=False)


def disp(model: Dict[str, Any]) -> str:
    """Return friendly model display name."""
    name = model.get("displayName") or model.get("publicName") or model.get("id") or "Unknown"
    return esc(name)


def val_or_dash(val: Any) -> str:
    return "—" if val is None or val == "" else esc(val)


def arrow(old_val: Any, new_val: Any) -> str:
    return f"{val_or_dash(old_val)} ➡️ {val_or_dash(new_val)}"


def fmt_rank(rank_val: Any) -> str:
    if rank_val is None or rank_val == UNRANKED:
        return "unranked"
    return esc(rank_val)


# ==============================================================================
# Fetch & Next.js Extraction
# ==============================================================================
PUSH_RE = re.compile(r'self\.__next_f\.push\(\[1,"((?:\\.|[^"\\])*)"\]\)', re.S)


def decode_nextjs_payload(html: str) -> str:
    """Unescape and join all Next.js Server Components __next_f.push string chunks."""
    parts = []
    for m in PUSH_RE.finditer(html):
        raw = m.group(1)
        try:
            parts.append(json.loads('"' + raw + '"'))
        except Exception:
            parts.append(raw)
    return "".join(parts)


def extract_json_array(text: str, key: str = '"initialModels":') -> Optional[str]:
    """Walk brackets from the '[' after `key` to its matching closing ']'."""
    idx = text.find(key)
    if idx == -1:
        return None
    start = text.find("[", idx)
    if start == -1:
        return None
    depth = 0
    in_str = False
    esc_char = False
    for i in range(start, len(text)):
        c = text[i]
        if in_str:
            if esc_char:
                esc_char = False
            elif c == "\\":
                esc_char = True
            elif c == '"':
                in_str = False
        else:
            if c == '"':
                in_str = True
            elif c == "[":
                depth += 1
            elif c == "]":
                depth -= 1
                if depth == 0:
                    return text[start : i + 1]
    return None


def fetch_arena_html() -> str:
    """Fetch arena.ai homepage HTML using cloudscraper (or requests fallback)."""
    try:
        import cloudscraper
        has_cloudscraper = True
    except ImportError:
        has_cloudscraper = False

    profiles = [
        {"browser": "chrome", "platform": "windows", "mobile": False},
        {"browser": "chrome", "platform": "linux", "mobile": False},
        {"browser": "firefox", "platform": "windows", "mobile": False},
        {"browser": "chrome", "platform": "android", "mobile": True},
    ]

    last_err = "unknown"
    for attempt in range(8):
        profile = profiles[attempt % len(profiles)]
        headers = {
            "User-Agent": (
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
            ),
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
        }
        try:
            if has_cloudscraper:
                scraper = cloudscraper.create_scraper(browser=profile)
                r = scraper.get(ARENA_URL, timeout=45)
            else:
                r = requests.get(ARENA_URL, headers=headers, timeout=45)

            if r.status_code == 200 and "initialModels" in r.text:
                return r.text
            last_err = f"HTTP {r.status_code}, len={len(r.text)}, initialModels={'initialModels' in r.text}"
        except Exception as e:
            last_err = str(e)

        wait_sec = 4 + random.random() * 6
        print(f"fetch attempt {attempt + 1} failed ({last_err}), retrying in {wait_sec:.1f}s")
        time.sleep(wait_sec)

    raise RuntimeError(f"Failed to fetch arena.ai after 8 attempts: {last_err}")


def parse_models_from_html(html: str) -> Dict[str, Dict[str, Any]]:
    """Extract and parse initialModels JSON into a dict keyed by raw model ID."""
    decoded = decode_nextjs_payload(html)
    raw_array = extract_json_array(decoded) or extract_json_array(html)
    if not raw_array:
        raise RuntimeError("initialModels array not found in arena.ai page")
    models = json.loads(raw_array)
    return {
        m["id"]: m
        for m in models
        if isinstance(m, dict) and "id" in m and isinstance(m["id"], str)
    }


# ==============================================================================
# Modality Health & Sanity Validation
# ==============================================================================
def check_modality_health(
    old_models: Optional[Dict[str, Dict[str, Any]]],
    new_models: Dict[str, Dict[str, Any]],
) -> Tuple[bool, str]:
    """
    Validates whether new_models represents a complete and healthy response.
    Catches partial Next.js SSR responses where an entire modality (e.g. Search, Image)
    failed to render on Arena's backend.
    """
    if not new_models:
        return False, "Empty model response (0 models)"

    if not old_models:
        # First run baseline: ensure minimum expected model count
        if len(new_models) < 100:
            return False, f"Baseline model count suspiciously low ({len(new_models)} models)"
        return True, "Baseline OK"

    old_count = len(old_models)
    new_count = len(new_models)

    # 1. Catastrophic overall count drop
    min_allowed = max(50, int(old_count * 0.60))
    if new_count < min_allowed:
        return (
            False,
            f"Catastrophic count drop: {new_count} models vs {old_count} baseline (<60%)",
        )

    # 2. Modality collapse detection
    old_mods = count_modalities(old_models)
    new_mods = count_modalities(new_models)

    for mod, count_before in old_mods.items():
        if count_before >= MODALITY_MIN_MODELS:
            count_after = new_mods.get(mod, 0)
            ratio = count_after / count_before
            if ratio < MIN_MODALITY_DROP_RATIO:
                return (
                    False,
                    f"Modality '{mod}' collapsed: {count_after} models vs {count_before} before "
                    f"({ratio * 100:.1f}% kept, minimum threshold is {MIN_MODALITY_DROP_RATIO * 100:.0f}%)",
                )

    return True, "Healthy"


def get_models(old_models: Optional[Dict[str, Dict[str, Any]]]) -> Tuple[Dict[str, Dict[str, Any]], bool, str]:
    """
    Fetches models from arena.ai with instant retry if an extracted response
    fails modality health check.
    Returns: (models_dict, is_valid, status_msg)
    """
    last_err = ""
    for attempt in range(3):
        try:
            html = fetch_arena_html()
            models = parse_models_from_html(html)
            is_healthy, reason = check_modality_health(old_models, models)
            if is_healthy:
                return models, True, "OK"
            print(f"Extraction attempt {attempt + 1} incomplete: {reason}. Retrying...")
            last_err = reason
            time.sleep(5)
        except Exception as e:
            last_err = str(e)
            time.sleep(4)

    # If all retries produced an incomplete fetch, return the last parsed models with invalid flag
    try:
        models = parse_models_from_html(html)
        return models, False, last_err
    except Exception:
        return {}, False, last_err


# ==============================================================================
# Model Identity Hashing & Alert State
# ==============================================================================
def snapshot_identity_hash(models: Dict[str, Dict[str, Any]]) -> str:
    """
    Computes a stable hash based purely on model IDs, public names, and capabilities.
    Unaffected by rank fluctuations, timestamps, or field ordering.
    """
    identities = []
    for mid in sorted(models.keys()):
        m = models[mid]
        pn = str(m.get("publicName") or "").strip()
        caps = tuple(sorted(flatten_caps(m)))
        identities.append((mid, pn, caps))
    payload = json.dumps(identities, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def load_alert_state() -> Dict[str, Any]:
    if not os.path.exists(ALERT_STATE_FILE):
        return {}
    try:
        with open(ALERT_STATE_FILE, encoding="utf-8") as f:
            state = json.load(f)
        return state if isinstance(state, dict) else {}
    except Exception:
        return {}


def save_alert_state(state: Dict[str, Any]) -> None:
    with open(ALERT_STATE_FILE, "w", encoding="utf-8") as f:
        json.dump(state, f, ensure_ascii=False, indent=1, sort_keys=True)


def load_snapshot() -> Optional[Dict[str, Dict[str, Any]]]:
    if not os.path.exists(SNAPSHOT_FILE):
        return None
    try:
        with open(SNAPSHOT_FILE, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def save_snapshot(models: Dict[str, Dict[str, Any]]) -> None:
    with open(SNAPSHOT_FILE, "w", encoding="utf-8") as f:
        json.dump(models, f, ensure_ascii=False, indent=1, sort_keys=True)


# ==============================================================================
# Deep Diff Engine
# ==============================================================================
class ModelChangeReport:
    def __init__(self):
        self.new_models: List[Dict[str, Any]] = []
        self.hidden_models: List[Dict[str, Any]] = []
        self.variants: List[Dict[str, Any]] = []
        self.name_updates: List[str] = []
        self.org_updates: List[str] = []
        self.provider_updates: List[str] = []
        self.capability_updates: List[str] = []
        self.id_rotations: List[Tuple[Dict[str, Any], Dict[str, Any]]] = []
        self.rank_updates: List[str] = []
        self.removed_models: List[Dict[str, Any]] = []

    def has_changes(self) -> bool:
        return any([
            self.new_models,
            self.hidden_models,
            self.variants,
            self.name_updates,
            self.org_updates,
            self.provider_updates,
            self.capability_updates,
            self.id_rotations,
            self.rank_updates,
            self.removed_models,
        ])


def detect_changes(
    old: Dict[str, Dict[str, Any]],
    new: Dict[str, Dict[str, Any]],
) -> ModelChangeReport:
    """
    Performs deep diff between old and new model snapshots:
    - Multi-pass ID rotation pairing
    - Categorization into new, stealth, and variant models
    - Existing model attribute updates (names, orgs, providers, capabilities, ranks)
    - Removals
    """
    report = ModelChangeReport()

    old_ids = set(old.keys())
    new_ids = set(new.keys())

    removed_ids = old_ids - new_ids
    added_ids = new_ids - old_ids
    common_ids = old_ids & new_ids

    # --------------------------------------------------------------------------
    # 1. Multi-Pass ID Rotation Pairing
    # --------------------------------------------------------------------------
    still_removed_ids = set(removed_ids)
    still_added_ids = set(added_ids)

    # Pass 1: Match by exact stripped publicName
    by_public_name: Dict[str, List[str]] = {}
    for mid in sorted(still_removed_ids):
        pn = str(old[mid].get("publicName") or "").strip()
        if pn:
            by_public_name.setdefault(pn, []).append(mid)

    for mid in sorted(still_added_ids):
        pn = str(new[mid].get("publicName") or "").strip()
        if pn and pn in by_public_name and by_public_name[pn]:
            old_mid = by_public_name[pn].pop(0)
            report.id_rotations.append((old[old_mid], new[mid]))
            still_removed_ids.discard(old_mid)
            still_added_ids.discard(mid)

    # Pass 2: Match remaining by exact stripped displayName
    by_display_name: Dict[str, List[str]] = {}
    for mid in sorted(still_removed_ids):
        dn = str(old[mid].get("displayName") or "").strip()
        if dn:
            by_display_name.setdefault(dn, []).append(mid)

    for mid in sorted(still_added_ids):
        dn = str(new[mid].get("displayName") or "").strip()
        if dn and dn in by_display_name and by_display_name[dn]:
            old_mid = by_display_name[dn].pop(0)
            report.id_rotations.append((old[old_mid], new[mid]))
            still_removed_ids.discard(old_mid)
            still_added_ids.discard(mid)

    # Record remaining removed models
    for mid in sorted(still_removed_ids):
        report.removed_models.append(old[mid])

    # --------------------------------------------------------------------------
    # 2. Classify Added Models
    # --------------------------------------------------------------------------
    old_public_names = {
        str(m.get("publicName") or "").strip()
        for m in old.values()
        if m.get("publicName")
    }

    for mid in sorted(still_added_ids):
        m = new[mid]
        org = str(m.get("organization") or "").strip()
        pn = str(m.get("publicName") or "").strip()

        if not org:
            # No organization = stealth / test / anonymous model
            report.hidden_models.append(m)
        elif pn in old_public_names:
            # Model with known public name = new variant or instance
            report.variants.append(m)
        else:
            # Brand new model
            report.new_models.append(m)

    # --------------------------------------------------------------------------
    # 3. Diff Existing Models
    # --------------------------------------------------------------------------
    for mid in sorted(common_ids):
        o = old[mid]
        n = new[mid]

        field_diffs = [
            (f, o.get(f), n.get(f))
            for f in TRACKED_FIELDS
            if o.get(f) != n.get(f)
        ]

        gained_caps = flatten_caps(n) - flatten_caps(o)
        lost_caps = flatten_caps(o) - flatten_caps(n)

        rank_changed = False
        if TRACK_RANK:
            if o.get("rank") != n.get("rank"):
                rank_changed = True
            elif o.get("rankByModality") != n.get("rankByModality"):
                rank_changed = True

        if not field_diffs and not gained_caps and not lost_caps and not rank_changed:
            continue

        # Format model block
        lines = []
        old_display, new_display = disp(o), disp(n)
        if old_display != new_display:
            lines.append(f"🔹 {old_display} ➡️ {new_display}")
        else:
            lines.append(f"🔹 {new_display}")
        lines.append(f"<code>{esc(mid)}</code>")

        for field, old_val, new_val in field_diffs:
            lines.append(f"• <b>{FIELD_LABELS.get(field, field)}</b>: {arrow(old_val, new_val)}")

        if gained_caps or lost_caps:
            lines.append("• <b>Capabilities</b>:")
            for cap in sorted(gained_caps):
                lines.append(f"  ➕ {esc(cap)}")
            for cap in sorted(lost_caps):
                lines.append(f"  ➖ {esc(cap)}")

        if rank_changed:
            lines.append(f"• <b>Rank</b>: {fmt_rank(o.get('rank'))} ➡️ {fmt_rank(n.get('rank'))}")
            old_mod_ranks = o.get("rankByModality") or {}
            new_mod_ranks = n.get("rankByModality") or {}
            all_mods = sorted(set(old_mod_ranks.keys()) | set(new_mod_ranks.keys()))
            for mod in all_mods:
                ov = old_mod_ranks.get(mod)
                nv = new_mod_ranks.get(mod)
                if ov != nv:
                    lines.append(f"  • {esc(mod)}: {fmt_rank(ov)} ➡️ {fmt_rank(nv)}")

        block = "\n".join(lines)
        changed_fields = {f for f, _, _ in field_diffs}

        # Categorize change into dedicated section
        if changed_fields & {"publicName", "displayName", "name"}:
            report.name_updates.append(block)
        elif "organization" in changed_fields:
            report.org_updates.append(block)
        elif "provider" in changed_fields:
            report.provider_updates.append(block)
        elif gained_caps or lost_caps:
            report.capability_updates.append(block)
        else:
            report.rank_updates.append(block)

    return report


# ==============================================================================
# Telegram Message Formatting & Delivery
# ==============================================================================
def format_model_card(model: Dict[str, Any], headline: Optional[str] = None) -> str:
    """Full detail card for added, stealth, variant, or removed models."""
    lines = []
    if headline:
        lines.append(f"🔹 <b>{esc(headline)}</b>")
    else:
        lines.append(f"🔹 <b>{disp(model)}</b>")
    lines.append(f"<code>{esc(model['id'])}</code>")

    for f in TRACKED_FIELDS:
        val = model.get(f)
        if val is not None or f in ("organization", "provider"):
            lines.append(f"• <b>{FIELD_LABELS.get(f, f)}</b>: {val_or_dash(val)}")

    caps = sorted(flatten_caps(model))
    lines.append(f"• <b>Capabilities</b>: {esc(', '.join(caps)) if caps else 'none'}")
    lines.append(f"• <b>Rank</b>: {fmt_rank(model.get('rank'))}")
    return "\n".join(lines)


def compact_section(blocks: List[str], limit: int = SECTION_LIMIT) -> List[str]:
    """Truncates blocks beyond limit to keep Telegram readable while noting total count."""
    if len(blocks) <= limit:
        return blocks
    return blocks[:limit] + [f"🔹 <i>…and {len(blocks) - limit} more</i>"]


def build_telegram_report(report: ModelChangeReport) -> Optional[str]:
    """Assembles a rich HTML message from the change report."""
    if not report.has_changes():
        return None

    sections: List[Tuple[str, int, List[str]]] = []

    if report.new_models:
        cards = [format_model_card(m) for m in report.new_models]
        sections.append(("🆕 <b>New models</b>", len(report.new_models), compact_section(cards)))

    if report.hidden_models:
        cards = [format_model_card(m) for m in report.hidden_models]
        sections.append(("🕵️ <b>Hidden / stealth models</b>", len(report.hidden_models), compact_section(cards)))

    if report.variants:
        cards = [format_model_card(m) for m in report.variants]
        sections.append(("🧬 <b>New variants</b>", len(report.variants), compact_section(cards)))

    if report.name_updates:
        sections.append(("✏️ <b>Name updates</b>", len(report.name_updates), compact_section(report.name_updates)))

    if report.org_updates:
        sections.append(("🏢 <b>Organization updates</b>", len(report.org_updates), compact_section(report.org_updates)))

    if report.provider_updates:
        sections.append(("🏭 <b>Provider updates</b>", len(report.provider_updates), compact_section(report.provider_updates)))

    if report.capability_updates:
        sections.append(("⚡ <b>Capability updates</b>", len(report.capability_updates), compact_section(report.capability_updates)))

    if report.id_rotations:
        rot_blocks = [
            f"🔹 {disp(n)}\n<code>{esc(o['id'])}</code> ➡️ <code>{esc(n['id'])}</code>"
            for o, n in report.id_rotations
        ]
        sections.append(("🆔 <b>ID rotations</b>", len(report.id_rotations), compact_section(rot_blocks)))

    if report.rank_updates:
        sections.append(("📊 <b>Rank updates</b>", len(report.rank_updates), compact_section(report.rank_updates)))

    if report.removed_models:
        cards = [format_model_card(m) for m in report.removed_models]
        sections.append(("❌ <b>Removed models</b>", len(report.removed_models), compact_section(cards)))

    if not sections:
        return None

    timestamp = datetime.datetime.now(datetime.timezone.utc).strftime("%d %b %Y, %H:%M UTC")
    message_parts = [
        f"📡 <b>Arena Tracker</b>\n🗓 {esc(timestamp)}",
        "━━━━━━━━━━━━━━━━━━━━",
    ]

    for title, count, blocks in sections:
        header = f"{title} — <b>{count}</b>"
        message_parts.append(header + "\n\n" + "\n\n".join(blocks))

    return "\n\n".join(message_parts)


def split_telegram_message(text: str, max_len: int = MAX_TELEGRAM_LEN) -> List[str]:
    """Splits long text across paragraph boundaries respecting Telegram limits."""
    if len(text) <= max_len:
        return [text]

    chunks: List[str] = []
    current_chunk = ""

    for paragraph in text.split("\n\n"):
        candidate = paragraph if not current_chunk else current_chunk + "\n\n" + paragraph
        if len(candidate) > max_len and current_chunk:
            chunks.append(current_chunk)
            current_chunk = paragraph
        else:
            current_chunk = candidate

    if current_chunk:
        chunks.append(current_chunk)

    return chunks


def send_telegram(text: str) -> None:
    """Sends message chunk to Telegram API. Prints to stdout in dry-run mode."""
    if not TELEGRAM_TOKEN or not TELEGRAM_CHAT_ID:
        print("\n[Telegram Dry-Run]\n" + text + "\n")
        return

    url = f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendMessage"
    payload = {
        "chat_id": TELEGRAM_CHAT_ID,
        "text": text,
        "parse_mode": "HTML",
        "disable_web_page_preview": True,
    }
    try:
        r = requests.post(url, json=payload, timeout=30)
        if r.status_code != 200:
            print(f"Telegram send error: {r.status_code} {r.text[:300]}")
    except Exception as e:
        print(f"Telegram network exception: {e}")


def notify_telegram(report_text: str) -> None:
    """Splits and sends Telegram report with 1-second delay between chunks."""
    chunks = split_telegram_message(report_text)
    for i, chunk in enumerate(chunks):
        send_telegram(chunk)
        if i < len(chunks) - 1:
            time.sleep(1)


# ==============================================================================
# Main Orchestrator
# ==============================================================================
def main() -> None:
    old_snapshot = load_snapshot()
    new_snapshot, is_valid, status_msg = get_models(old_snapshot)

    print(f"Loaded old: {len(old_snapshot) if old_snapshot else 0} models | Fetched new: {len(new_snapshot)} models")

    # 1. Modality & Sanity Guard: Protect against broken / partial fetches
    if not is_valid:
        print(f"⚠️ Fetch rejected: {status_msg}")
        alert_state = load_alert_state()
        # Notify Telegram once per broken incident to prevent spamming every minute
        if not alert_state.get("broken_notified"):
            send_telegram(
                f"⚠️ <b>Arena Fetch Incomplete</b>\n"
                f"{esc(status_msg)}\n"
                f"Skipping update to preserve baseline snapshot."
            )
            alert_state["broken_notified"] = True
            save_alert_state(alert_state)
        return

    # Clear broken notification state if fetch is healthy
    alert_state = load_alert_state()
    if alert_state.get("broken_notified"):
        alert_state.pop("broken_notified", None)
        save_alert_state(alert_state)

    # 2. First Run: Initialize baseline
    if old_snapshot is None:
        save_snapshot(new_snapshot)
        send_telegram(
            f"✅ <b>Arena tracker started</b>\n"
            f"Loaded {len(new_snapshot)} models as initial baseline.\n"
            f"Alerts will trigger starting from the next change."
        )
        print("Initial baseline snapshot saved.")
        return

    # 3. Large Churn Confirmation Guard
    # If 20+ models are added or removed in a single minute, require persistence across 2 runs
    added_count = len(set(new_snapshot.keys()) - set(old_snapshot.keys()))
    removed_count = len(set(old_snapshot.keys()) - set(new_snapshot.keys()))
    is_large_batch = max(added_count, removed_count) >= LARGE_BATCH_THRESHOLD

    if is_large_batch:
        candidate_hash = snapshot_identity_hash(new_snapshot)
        pending_hash = alert_state.get("pending_large_hash")
        pending_count = int(alert_state.get("pending_large_count", 0))

        if pending_hash == candidate_hash:
            pending_count += 1
        else:
            pending_hash = candidate_hash
            pending_count = 1

        if pending_count < 2:
            alert_state["pending_large_hash"] = pending_hash
            alert_state["pending_large_count"] = pending_count
            alert_state["pending_added"] = added_count
            alert_state["pending_removed"] = removed_count
            save_alert_state(alert_state)
            print(
                f"Large batch detected (+{added_count}/-{removed_count}). "
                f"Holding for confirmation (seen {pending_count}/2 runs)..."
            )
            return

        # Confirmed across 2 consecutive runs! Clear pending state and proceed to alert
        alert_state.pop("pending_large_hash", None)
        alert_state.pop("pending_large_count", None)
        save_alert_state(alert_state)
    elif alert_state.get("pending_large_hash"):
        # A normal, non-large state cancels any unconfirmed pending batch
        alert_state.pop("pending_large_hash", None)
        alert_state.pop("pending_large_count", None)
        save_alert_state(alert_state)

    # 4. Deep Change Detection
    report = detect_changes(old_snapshot, new_snapshot)
    if report.has_changes():
        message = build_telegram_report(report)
        if message:
            notify_telegram(message)
            print("Changes detected and Telegram notification sent.")
    else:
        print("No changes detected.")

    # 5. Commit Valid Snapshot
    save_snapshot(new_snapshot)


if __name__ == "__main__":
    main()
