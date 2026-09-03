#!/usr/bin/env python3
"""
LM Arena Model Tracker - Premium Dashboard Grid Edition

Monitors canaryarena.ai model metadata every minute and sends clean, modern
Discord 3-column dashboard grid cards when genuine changes occur:
- 🆕 Brand new models (Emerald Green dashboard card)
- 🕵️ Hidden / stealth test models (Amethyst Purple card)
- 🧬 New variants of existing models (Turquoise Teal card)
- ✏️ Name & display updates (Sky Blue grid card)
- 🏢 Organization updates (Sunflower Gold card)
- 🏭 Provider updates (Carrot Orange card)
- ⚡ Capability updates (Orange Gold card with badges)
- 🆔 ID rotations (Pastel Blurple card)
- 📊 Real rank updates (Dark Navy card, filters out unranked->unranked)
- ❌ Genuine model removals (Alizarin Red card)

Engineered for 1-minute execution intervals with:
- Modality health validation (prevents false alerts on partial SSR drops)
- In-memory auto-retry on transient backend dropouts
- Stable identity-based batch confirmation for large churn (>20 models)
- Anti-flapping snapshot protection
- Discord 3-Column Inline Grid Layout with zero visual clutter
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

SECTION_LIMIT = 15            # Maximum individual cards per event type in single run
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

# Clean Discord Colors
COLORS = {
    "brand": 0x5865F2,     # Blurple
    "new": 0x2ECC71,       # Emerald Green
    "stealth": 0x9B59B6,   # Amethyst Purple
    "variant": 0x1ABC9C,   # Turquoise / Teal
    "rename": 0x3498DB,    # Sky Blue
    "org": 0xF1C40F,       # Sunflower Yellow
    "provider": 0xE67E22,  # Carrot Orange
    "capability": 0xF39C12,# Orange Gold
    "rotation": 0x7289DA,  # Pastel Blurple
    "rank": 0x34495E,      # Dark Navy
    "removed": 0xE74C3C,   # Red
    "warning": 0xE67E22,   # Amber
}

AUTHOR_INFO = {
    "name": "LMSYS Arena Tracker",
    "url": ARENA_URL,
    "icon_url": "https://arena.ai/favicon.ico",
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


def format_capability_badges(model: Dict[str, Any]) -> str:
    """Formats model capabilities into readable, clean emoji badges."""
    badges = []
    c = model.get("capabilities") or {}
    inp = c.get("inputCapabilities") or {}
    out = c.get("outputCapabilities") or {}

    if inp.get("text"): badges.append("💬 Text")
    if inp.get("image"): badges.append("🖼️ Image In")
    if inp.get("video"): badges.append("🎬 Video In")
    if inp.get("file"): badges.append("📁 File")

    if out.get("search"): badges.append("🔍 Search")
    if out.get("web"): badges.append("🌐 Web")
    if out.get("image"): badges.append("🎨 Image Gen")
    if out.get("video"): badges.append("🎥 Video Gen")

    if not badges:
        raw = sorted(flatten_caps(model))
        return " • ".join(f"`{r}`" for r in raw[:5]) if raw else "*None*"
    return " • ".join(f"`{b}`" for b in badges)


def disp(model: Dict[str, Any]) -> str:
    """Return clean model display name."""
    return str(model.get("displayName") or model.get("publicName") or model.get("id") or "Unknown")


def val_or_dash(val: Any) -> str:
    return "—" if val is None or str(val).strip() in ("", "None") else str(val)


def fmt_rank(rank_val: Any) -> str:
    if rank_val is None or rank_val == UNRANKED:
        return "Unranked"
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
            old_rank_str = fmt_rank(o.get("rank"))
            new_rank_str = fmt_rank(n.get("rank"))
            # Crucial fix: Only flag if there is a real visible change!
            # Never alert unranked -> unranked!
            if old_rank_str != new_rank_str:
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
        elif rank_changed:
            report.rank_updates.append(item)

    return report


# ==============================================================================
# Discord 3-Column Dashboard Grid Cards
# ==============================================================================
def create_model_grid_embed(
    title: str,
    color: int,
    model: Dict[str, Any],
    status_label: str = "Live",
) -> Dict[str, Any]:
    """
    Renders a stunning 3-column dashboard grid card for an individual model event.
    No messy walls of text: clean 3 columns (Org | Modality | Rank) + badges.
    """
    now_iso = datetime.datetime.now(datetime.timezone.utc).isoformat()
    org = val_or_dash(model.get("organization"))
    prov = val_or_dash(model.get("provider"))
    rank = fmt_rank(model.get("rank"))
    badges = format_capability_badges(model)

    fields = [
        {"name": "🏢 Organization", "value": f"**{org}**", "inline": True},
        {"name": "🏭 Provider", "value": f"**{prov}**", "inline": True},
        {"name": "📊 Arena Rank", "value": f"**{rank}**", "inline": True},
        {"name": "🛠️ Capabilities", "value": badges, "inline": False},
    ]

    return {
        "author": AUTHOR_INFO,
        "title": title,
        "description": f"**Model ID:** `{model['id']}`",
        "color": color,
        "fields": fields,
        "timestamp": now_iso,
        "footer": {"text": f"Canary Arena • {status_label}"},
    }


def build_discord_embeds(report: ModelChangeReport) -> List[Dict[str, Any]]:
    """Builds a refined array of Discord 3-column dashboard grid cards."""
    embeds: List[Dict[str, Any]] = []
    now_iso = datetime.datetime.now(datetime.timezone.utc).isoformat()
    footer = {"text": "Canary Arena • canaryarena.ai"}

    # 1. 🆕 Brand New Models (Individual Grid Cards)
    for m in report.new_models[:SECTION_LIMIT]:
        embeds.append(
            create_model_grid_embed(
                title=f"🆕 New Model: {disp(m)}",
                color=COLORS["new"],
                model=m,
                status_label="New Release",
            )
        )

    # 2. 🕵️ Stealth / Hidden Models (Individual Grid Cards)
    for m in report.hidden_models[:SECTION_LIMIT]:
        card = create_model_grid_embed(
            title=f"🕵️ Stealth Model: {disp(m)}",
            color=COLORS["stealth"],
            model=m,
            status_label="Stealth / Anonymous",
        )
        # Override Org field for stealth
        card["fields"][0] = {"name": "🏢 Organization", "value": "*Unannounced / Stealth*", "inline": True}
        embeds.append(card)

    # 3. 🧬 New Variants (Individual Grid Cards)
    for m in report.variants[:SECTION_LIMIT]:
        embeds.append(
            create_model_grid_embed(
                title=f"🧬 New Variant: {disp(m)}",
                color=COLORS["variant"],
                model=m,
                status_label="Variant Instance",
            )
        )

    # 4. ✏️ Name Updates (High-Density Dashboard Grid)
    if report.name_updates:
        fields = []
        for item in report.name_updates[:SECTION_LIMIT]:
            old_name = val_or_dash(item["old"].get("displayName") or item["old"].get("publicName"))
            new_name = val_or_dash(item["new"].get("displayName") or item["new"].get("publicName"))
            fields.extend([
                {"name": "Previous Name", "value": f"`{old_name}`", "inline": True},
                {"name": "➡️", "value": "➔", "inline": True},
                {"name": "Updated Name", "value": f"**`{new_name}`**", "inline": True},
                {"name": "Model ID", "value": f"`{item['id']}`", "inline": False},
            ])
        embeds.append({
            "author": AUTHOR_INFO,
            "title": f"✏️ Model Name Updates ({len(report.name_updates)})",
            "color": COLORS["rename"],
            "fields": fields,
            "timestamp": now_iso,
            "footer": footer,
        })

    # 5. 🏢 Organization Updates
    if report.org_updates:
        fields = []
        for item in report.org_updates[:SECTION_LIMIT]:
            diffs = [f"{FIELD_LABELS.get(f, f)}: {val_or_dash(ov)} ➔ **{val_or_dash(nv)}**" for f, ov, nv in item["diffs"]]
            fields.append({
                "name": f"🏢 {disp(item['new'])}",
                "value": "\n".join(diffs) + f"\n`{item['id']}`",
                "inline": False,
            })
        embeds.append({
            "author": AUTHOR_INFO,
            "title": f"🏢 Organization Updates ({len(report.org_updates)})",
            "color": COLORS["org"],
            "fields": fields,
            "timestamp": now_iso,
            "footer": footer,
        })

    # 6. 🏭 Provider Updates
    if report.provider_updates:
        fields = []
        for item in report.provider_updates[:SECTION_LIMIT]:
            diffs = [f"{val_or_dash(ov)} ➔ **{val_or_dash(nv)}**" for _, ov, nv in item["diffs"]]
            fields.append({
                "name": f"🏭 {disp(item['new'])}",
                "value": "\n".join(diffs) + f"\n`{item['id']}`",
                "inline": False,
            })
        embeds.append({
            "author": AUTHOR_INFO,
            "title": f"🏭 Provider Updates ({len(report.provider_updates)})",
            "color": COLORS["provider"],
            "fields": fields,
            "timestamp": now_iso,
            "footer": footer,
        })

    # 7. ⚡ Capability Updates (Clean Badge Grid)
    if report.capability_updates:
        fields = []
        for item in report.capability_updates[:SECTION_LIMIT]:
            gained = [f"`+{g}`" for g in sorted(item["gained_caps"])]
            lost = [f"`-{l}`" for l in sorted(item["lost_caps"])]

            parts = []
            if gained: parts.append(f"🟢 **Added:** {' '.join(gained)}")
            if lost: parts.append(f"🔴 **Removed:** {' '.join(lost)}")

            fields.append({
                "name": f"⚡ {disp(item['new'])}",
                "value": "\n".join(parts) + f"\n`{item['id']}`",
                "inline": False,
            })
        embeds.append({
            "author": AUTHOR_INFO,
            "title": f"⚡ Capability Updates ({len(report.capability_updates)})",
            "color": COLORS["capability"],
            "fields": fields,
            "timestamp": now_iso,
            "footer": footer,
        })

    # 8. 🆔 ID Rotations (3-Column Clean Row)
    if report.id_rotations:
        fields = []
        for old_m, new_m in report.id_rotations[:SECTION_LIMIT]:
            fields.extend([
                {"name": f"Model: {disp(new_m)}", "value": f"**Old:** `{old_m['id']}`", "inline": True},
                {"name": "➡️", "value": "➔", "inline": True},
                {"name": "Rotated ID", "value": f"**New:** `{new_m['id']}`", "inline": True},
            ])
        embeds.append({
            "author": AUTHOR_INFO,
            "title": f"🆔 ID Rotations ({len(report.id_rotations)})",
            "color": COLORS["rotation"],
            "fields": fields,
            "timestamp": now_iso,
            "footer": footer,
        })

    # 9. 📊 Real Rank Updates (Filters unranked->unranked)
    if report.rank_updates:
        fields = []
        for item in report.rank_updates[:SECTION_LIMIT]:
            o, n = item["old"], item["new"]
            old_r, new_r = fmt_rank(o.get("rank")), fmt_rank(n.get("rank"))
            fields.extend([
                {"name": f"📊 {disp(n)}", "value": f"`{old_r}`", "inline": True},
                {"name": "➡️", "value": "➔", "inline": True},
                {"name": "New Rank", "value": f"**`{new_r}`**", "inline": True},
            ])
        if fields:
            embeds.append({
                "author": AUTHOR_INFO,
                "title": f"📊 Rank Shifts ({len(report.rank_updates)})",
                "color": COLORS["rank"],
                "fields": fields,
                "timestamp": now_iso,
                "footer": footer,
            })

    # 10. ❌ Removed Models (Individual Grid Cards)
    for m in report.removed_models[:SECTION_LIMIT]:
        embeds.append(
            create_model_grid_embed(
                title=f"❌ Model Removed: {disp(m)}",
                color=COLORS["removed"],
                model=m,
                status_label="Delisted / Retired",
            )
        )

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
    Sends Discord embeds in clean batches (max 4 per webhook message)
    to respect Discord rate limits and maximum payload sizing.
    """
    if not embeds:
        return

    batch_size = 4
    for i in range(0, len(embeds), batch_size):
        chunk = embeds[i : i + batch_size]
        send_discord_payload({"embeds": chunk})
        if i + batch_size < len(embeds):
            time.sleep(1)


def send_discord_text(text: str, color: int = COLORS["brand"]) -> None:
    """Helper to send a clean system status alert to Discord."""
    now_iso = datetime.datetime.now(datetime.timezone.utc).isoformat()
    send_discord_payload({
        "embeds": [{
            "author": AUTHOR_INFO,
            "description": text,
            "color": color,
            "timestamp": now_iso,
            "footer": {"text": "Canary Arena • canaryarena.ai"},
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
