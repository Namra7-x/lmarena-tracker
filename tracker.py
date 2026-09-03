#!/usr/bin/env python3
"""
LM Arena Model Tracker - Discord Rich UI Edition

Monitors canaryarena.ai model metadata every minute and sends clean, rich
Discord Webhook Embed alerts when genuine changes occur:
- 🆕 Brand new models (Green embed)
- 🕵️ Hidden / stealth test models (Purple embed)
- 🧬 New variants of existing models (Teal embed)
- ✏️ Name / display-name updates (Blue embed)
- 🏢 Organization updates (Gold embed)
- 🏭 Provider updates (Orange embed)
- ⚡ Capability updates (Yellow embed)
- 🆔 ID rotations (Blurple embed)
- 📊 Rank updates (Navy embed)
- ❌ Genuine model removals (Red embed)

Engineered for 1-minute execution intervals with:
- Modality health validation (prevents false alerts on partial SSR drops)
- In-memory auto-retry on transient backend dropouts
- Stable identity-based batch confirmation for large churn (>20 models)
- Anti-flapping snapshot protection
- Rich Discord Embed UI formatting with automatic batching
"""

from __future__ import annotations

import datetime
import hashlib
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
ARENA_URL = os.environ.get("ARENA_URL", "https://canaryarena.ai/").strip()
SNAPSHOT_FILE = "snapshot.json"
ALERT_STATE_FILE = ".arena_alert_state.json"

DISCORD_WEBHOOK_URL = (
    os.environ.get("DISCORD_WEBHOOK_URL")
    or os.environ.get("DISCORD_WEBHOOK")
    or ""
).strip()

TRACK_RANK = os.environ.get("TRACK_RANK", "false").lower() == "true"

SECTION_LIMIT = 20            # Limit per section in alerts
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

# Discord Embed Color Palette
COLORS = {
    "brand": 0x5865F2,     # Discord Blurple
    "new": 0x2ECC71,       # Emerald Green
    "stealth": 0x9B59B6,   # Amethyst Purple
    "variant": 0x1ABC9C,   # Turquoise / Teal
    "rename": 0x3498DB,    # Sky Blue
    "org": 0xF1C40F,       # Sunflower Yellow
    "provider": 0xE67E22,  # Carrot Orange
    "capability": 0xF39C12,# Orange Gold
    "rotation": 0x7289DA,  # Pastel Blurple
    "rank": 0x34495E,      # Wet Asphalt Dark Blue
    "removed": 0xE74C3C,   # Alizarin Red
    "warning": 0xE67E22,   # Warning Amber
}


# ==============================================================================
# Model Normalization & Capability Helpers
# ==============================================================================
def get_model_modalities(model: Dict[str, Any]) -> Set[str]:
    """Return set of normalized modalities for a model (chat, webdev, image, video, search)."""
    mods = set()
    caps = (model.get("capabilities") or {}).get("outputCapabilities") or {}
    for k, v in caps.items():
        if v:
            norm = MODALITY_NORMALIZER.get(k.lower(), k.lower())
            mods.add(norm)
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


def disp(model: Dict[str, Any]) -> str:
    """Return friendly model display name."""
    return str(model.get("displayName") or model.get("publicName") or model.get("id") or "Unknown")


def val_or_dash(val: Any) -> str:
    return "—" if val is None or str(val).strip() == "" else str(val)


def arrow(old_val: Any, new_val: Any) -> str:
    return f"{val_or_dash(old_val)} ➔ {val_or_dash(new_val)}"


def fmt_rank(rank_val: Any) -> str:
    if rank_val is None or rank_val == UNRANKED:
        return "unranked"
    return f"#{rank_val}"


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
    """Fetch canaryarena.ai homepage HTML using cloudscraper (or requests fallback)."""
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

    raise RuntimeError(f"Failed to fetch {ARENA_URL} after 8 attempts: {last_err}")


def parse_models_from_html(html: str) -> Dict[str, Dict[str, Any]]:
    """Extract and parse initialModels JSON into a dict keyed by raw model ID."""
    decoded = decode_nextjs_payload(html)
    raw_array = extract_json_array(decoded) or extract_json_array(html)
    if not raw_array:
        raise RuntimeError("initialModels array not found in arena page")
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
    Fetches models from canaryarena.ai with instant retry if an extracted response
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
        self.name_updates: List[Dict[str, Any]] = []
        self.org_updates: List[Dict[str, Any]] = []
        self.provider_updates: List[Dict[str, Any]] = []
        self.capability_updates: List[Dict[str, Any]] = []
        self.id_rotations: List[Tuple[Dict[str, Any], Dict[str, Any]]] = []
        self.rank_updates: List[Dict[str, Any]] = []
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
            report.hidden_models.append(m)
        elif pn in old_public_names:
            report.variants.append(m)
        else:
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

        item = {
            "id": mid,
            "old": o,
            "new": n,
            "diffs": field_diffs,
            "gained_caps": gained_caps,
            "lost_caps": lost_caps,
            "rank_changed": rank_changed,
        }

        changed_fields = {f for f, _, _ in field_diffs}
        if changed_fields & {"publicName", "displayName", "name"}:
            report.name_updates.append(item)
        elif "organization" in changed_fields:
            report.org_updates.append(item)
        elif "provider" in changed_fields:
            report.provider_updates.append(item)
        elif gained_caps or lost_caps:
            report.capability_updates.append(item)
        else:
            report.rank_updates.append(item)

    return report


# ==============================================================================
# Discord Rich Embed Formatting & Webhook Delivery
# ==============================================================================
def format_embed_model_value(m: Dict[str, Any]) -> str:
    """Formats a concise, high-density markdown block for a model."""
    lines = [f"**ID:** `{m['id']}`"]
    org = m.get("organization")
    prov = m.get("provider")
    meta_parts = []
    if org:
        meta_parts.append(f"**Org:** {org}")
    if prov and prov != org:
        meta_parts.append(f"**Provider:** {prov}")
    if meta_parts:
        lines.append(" • ".join(meta_parts))

    caps = sorted(flatten_caps(m))
    if caps:
        caps_str = ", ".join(f"`{c}`" for c in caps[:6])
        if len(caps) > 6:
            caps_str += f" +{len(caps) - 6} more"
        lines.append(f"**Caps:** {caps_str}")

    rank_str = fmt_rank(m.get("rank"))
    if rank_str != "unranked":
        lines.append(f"**Rank:** {rank_str}")

    return "\n".join(lines)


def build_discord_embeds(report: ModelChangeReport) -> List[Dict[str, Any]]:
    """Builds a rich array of Discord embed objects from the change report."""
    embeds: List[Dict[str, Any]] = []
    now_iso = datetime.datetime.now(datetime.timezone.utc).isoformat()
    footer = {"text": "Arena Tracker • canaryarena.ai"}

    # 1. 🆕 Brand New Models
    if report.new_models:
        fields = []
        for m in report.new_models[:SECTION_LIMIT]:
            fields.append({
                "name": f"✨ {disp(m)}",
                "value": format_embed_model_value(m),
                "inline": False,
            })
        if len(report.new_models) > SECTION_LIMIT:
            fields.append({
                "name": "…and more",
                "value": f"*{len(report.new_models) - SECTION_LIMIT} additional new models omitted*",
                "inline": False,
            })
        embeds.append({
            "title": f"🆕 Brand New Models ({len(report.new_models)})",
            "description": "New models added to the Arena with verified organizations.",
            "color": COLORS["new"],
            "fields": fields,
            "timestamp": now_iso,
            "footer": footer,
        })

    # 2. 🕵️ Hidden / Stealth Models
    if report.hidden_models:
        fields = []
        for m in report.hidden_models[:SECTION_LIMIT]:
            fields.append({
                "name": f"🕵️ {disp(m)}",
                "value": format_embed_model_value(m),
                "inline": False,
            })
        if len(report.hidden_models) > SECTION_LIMIT:
            fields.append({
                "name": "…and more",
                "value": f"*{len(report.hidden_models) - SECTION_LIMIT} additional stealth models omitted*",
                "inline": False,
            })
        embeds.append({
            "title": f"🕵️ Stealth / Hidden Models ({len(report.hidden_models)})",
            "description": "Anonymous or test models detected without public organizations.",
            "color": COLORS["stealth"],
            "fields": fields,
            "timestamp": now_iso,
            "footer": footer,
        })

    # 3. 🧬 New Variants
    if report.variants:
        fields = []
        for m in report.variants[:SECTION_LIMIT]:
            fields.append({
                "name": f"🧬 {disp(m)} (Variant)",
                "value": format_embed_model_value(m),
                "inline": False,
            })
        if len(report.variants) > SECTION_LIMIT:
            fields.append({
                "name": "…and more",
                "value": f"*{len(report.variants) - SECTION_LIMIT} additional variants omitted*",
                "inline": False,
            })
        embeds.append({
            "title": f"🧬 New Model Variants ({len(report.variants)})",
            "description": "New instances sharing public names of existing models.",
            "color": COLORS["variant"],
            "fields": fields,
            "timestamp": now_iso,
            "footer": footer,
        })

    # 4. ✏️ Name Updates
    if report.name_updates:
        lines = []
        for item in report.name_updates[:SECTION_LIMIT]:
            old_d, new_d = disp(item["old"]), disp(item["new"])
            lines.append(f"• **{old_d}** ➔ **{new_d}**\n  `{item['id']}`")
        if len(report.name_updates) > SECTION_LIMIT:
            lines.append(f"*…and {len(report.name_updates) - SECTION_LIMIT} more*")
        embeds.append({
            "title": f"✏️ Name & Display Updates ({len(report.name_updates)})",
            "description": "\n\n".join(lines),
            "color": COLORS["rename"],
            "timestamp": now_iso,
            "footer": footer,
        })

    # 5. 🏢 Organization Updates
    if report.org_updates:
        lines = []
        for item in report.org_updates[:SECTION_LIMIT]:
            diffs = [f"{FIELD_LABELS.get(f, f)}: {arrow(ov, nv)}" for f, ov, nv in item["diffs"]]
            lines.append(f"• **{disp(item['new'])}** (`{item['id']}`)\n  " + "\n  ".join(diffs))
        if len(report.org_updates) > SECTION_LIMIT:
            lines.append(f"*…and {len(report.org_updates) - SECTION_LIMIT} more*")
        embeds.append({
            "title": f"🏢 Organization Updates ({len(report.org_updates)})",
            "description": "\n\n".join(lines),
            "color": COLORS["org"],
            "timestamp": now_iso,
            "footer": footer,
        })

    # 6. 🏭 Provider Updates
    if report.provider_updates:
        lines = []
        for item in report.provider_updates[:SECTION_LIMIT]:
            diffs = [f"{FIELD_LABELS.get(f, f)}: {arrow(ov, nv)}" for f, ov, nv in item["diffs"]]
            lines.append(f"• **{disp(item['new'])}** (`{item['id']}`)\n  " + "\n  ".join(diffs))
        if len(report.provider_updates) > SECTION_LIMIT:
            lines.append(f"*…and {len(report.provider_updates) - SECTION_LIMIT} more*")
        embeds.append({
            "title": f"🏭 Provider Updates ({len(report.provider_updates)})",
            "description": "\n\n".join(lines),
            "color": COLORS["provider"],
            "timestamp": now_iso,
            "footer": footer,
        })

    # 7. ⚡ Capability Updates
    if report.capability_updates:
        lines = []
        for item in report.capability_updates[:SECTION_LIMIT]:
            parts = [f"• **{disp(item['new'])}** (`{item['id']}`)"]
            for g in sorted(item["gained_caps"]):
                parts.append(f"  🟢 **+** `{g}`")
            for l in sorted(item["lost_caps"]):
                parts.append(f"  🔴 **-** `{l}`")
            lines.append("\n".join(parts))
        if len(report.capability_updates) > SECTION_LIMIT:
            lines.append(f"*…and {len(report.capability_updates) - SECTION_LIMIT} more*")
        embeds.append({
            "title": f"⚡ Capability Updates ({len(report.capability_updates)})",
            "description": "\n\n".join(lines),
            "color": COLORS["capability"],
            "timestamp": now_iso,
            "footer": footer,
        })

    # 8. 🆔 ID Rotations
    if report.id_rotations:
        lines = []
        for old_m, new_m in report.id_rotations[:SECTION_LIMIT]:
            lines.append(
                f"• **{disp(new_m)}**\n"
                f"  `{old_m['id']}` ➔ `{new_m['id']}`"
            )
        if len(report.id_rotations) > SECTION_LIMIT:
            lines.append(f"*…and {len(report.id_rotations) - SECTION_LIMIT} more*")
        embeds.append({
            "title": f"🆔 ID Rotations ({len(report.id_rotations)})",
            "description": "Model IDs rotated while public identity remained identical.",
            "color": COLORS["rotation"],
            "fields": [{"name": "Rotated Identifiers", "value": "\n".join(lines)}],
            "timestamp": now_iso,
            "footer": footer,
        })

    # 9. 📊 Rank Updates
    if report.rank_updates:
        lines = []
        for item in report.rank_updates[:SECTION_LIMIT]:
            o, n = item["old"], item["new"]
            lines.append(f"• **{disp(n)}**: {fmt_rank(o.get('rank'))} ➔ {fmt_rank(n.get('rank'))}")
        if len(report.rank_updates) > SECTION_LIMIT:
            lines.append(f"*…and {len(report.rank_updates) - SECTION_LIMIT} more*")
        embeds.append({
            "title": f"📊 Rank Updates ({len(report.rank_updates)})",
            "description": "\n".join(lines),
            "color": COLORS["rank"],
            "timestamp": now_iso,
            "footer": footer,
        })

    # 10. ❌ Removed Models
    if report.removed_models:
        fields = []
        for m in report.removed_models[:SECTION_LIMIT]:
            fields.append({
                "name": f"❌ {disp(m)}",
                "value": format_embed_model_value(m),
                "inline": False,
            })
        if len(report.removed_models) > SECTION_LIMIT:
            fields.append({
                "name": "…and more",
                "value": f"*{len(report.removed_models) - SECTION_LIMIT} additional removed models omitted*",
                "inline": False,
            })
        embeds.append({
            "title": f"❌ Removed Models ({len(report.removed_models)})",
            "description": "Models delisted or retired from the Arena.",
            "color": COLORS["removed"],
            "fields": fields,
            "timestamp": now_iso,
            "footer": footer,
        })

    return embeds


def send_discord_payload(payload: Dict[str, Any]) -> None:
    """Dispatches a JSON payload to the configured Discord webhook URL."""
    if not DISCORD_WEBHOOK_URL:
        print("\n[Discord Webhook Dry-Run]")
        print(json.dumps(payload, indent=2))
        return

    try:
        r = requests.post(DISCORD_WEBHOOK_URL, json=payload, timeout=30)
        if r.status_code not in (200, 204):
            print(f"Discord webhook error: {r.status_code} {r.text[:300]}")
    except Exception as e:
        print(f"Discord network exception: {e}")


def notify_discord_embeds(embeds: List[Dict[str, Any]]) -> None:
    """
    Sends Discord embeds in batches of up to 4 embeds per webhook message
    to respect Discord rate limits and maximum payload sizing.
    """
    if not embeds:
        return

    # Discord allows max 10 embeds per message; batch in groups of 4 for clean reading
    batch_size = 4
    for i in range(0, len(embeds), batch_size):
        chunk = embeds[i : i + batch_size]
        send_discord_payload({"embeds": chunk})
        if i + batch_size < len(embeds):
            time.sleep(1)


def send_discord_text(text: str, color: int = COLORS["brand"]) -> None:
    """Helper to send a simple embedded system alert to Discord."""
    now_iso = datetime.datetime.now(datetime.timezone.utc).isoformat()
    send_discord_payload({
        "embeds": [{
            "description": text,
            "color": color,
            "timestamp": now_iso,
            "footer": {"text": "Arena Tracker • canaryarena.ai"},
        }]
    })


# ==============================================================================
# Main Orchestrator
# ==============================================================================
def main() -> None:
    old_snapshot = load_snapshot()
    new_snapshot, is_valid, status_msg = get_models(old_snapshot)

    print(f"Loaded old: {len(old_snapshot) if old_snapshot else 0} models | Fetched new: {len(new_snapshot)} models ({ARENA_URL})")

    # 1. Modality & Sanity Guard: Protect against broken / partial fetches
    if not is_valid:
        print(f"⚠️ Fetch rejected: {status_msg}")
        alert_state = load_alert_state()
        if not alert_state.get("broken_notified"):
            send_discord_text(
                f"⚠️ **Arena Fetch Incomplete**\n{status_msg}\n*Skipping snapshot update to protect baseline.*",
                color=COLORS["warning"],
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
        send_discord_text(
            f"✅ **Arena Tracker Initialized**\nLoaded `{len(new_snapshot)}` models from `{ARENA_URL}` as baseline.\nAlerts will trigger starting from the next change.",
            color=COLORS["new"],
        )
        print("Initial baseline snapshot saved.")
        return

    # 3. Large Churn Confirmation Guard
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
        alert_state.pop("pending_large_hash", None)
        alert_state.pop("pending_large_count", None)
        save_alert_state(alert_state)

    # 4. Deep Change Detection
    report = detect_changes(old_snapshot, new_snapshot)
    if report.has_changes():
        embeds = build_discord_embeds(report)
        if embeds:
            notify_discord_embeds(embeds)
            print(f"Changes detected: sent {len(embeds)} Discord embed(s).")
    else:
        print("No changes detected.")

    # 5. Commit Valid Snapshot
    save_snapshot(new_snapshot)


if __name__ == "__main__":
    main()
