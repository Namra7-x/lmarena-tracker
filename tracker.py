#!/usr/bin/env python3
"""
Arena (LMArena) model tracker
Fetches arena.ai, extracts embedded initialModels JSON, diffs vs snapshot,
sends clean Telegram alerts: new / hidden / variants / renames / org /
capabilities / id rotations / removed.
"""

import os
import re
import json
import time
import random
import datetime
import requests

# ---------------- config ----------------
URLS = ["https://arena.ai/", "https://lmarena.ai/"]
SNAPSHOT_FILE = "snapshot.json"
TELEGRAM_TOKEN = os.environ.get("TELEGRAM_TOKEN", "")
TELEGRAM_CHAT_ID = os.environ.get("TELEGRAM_CHAT_ID", "")
TRACK_RANK = os.environ.get("TRACK_RANK", "false").lower() == "true"
MAX_MSG = 4000          # telegram hard limit is 4096
UNRANKED = 9007199254740991  # JS Number.MAX_SAFE_INTEGER = "no rank"

FIELDS = ["publicName", "displayName", "name",
          "organization", "provider", "userSelectable"]


# ---------------- fetch & extract ----------------
def fetch_html():
    import cloudscraper
    profiles = [
        {"browser": "chrome", "platform": "windows", "mobile": False},
        {"browser": "chrome", "platform": "linux", "mobile": False},
        {"browser": "firefox", "platform": "windows", "mobile": False},
        {"browser": "chrome", "platform": "android", "mobile": True},
    ]
    last_err = "unknown"
    for attempt in range(12):  # 12 tries instead of 6
        url = URLS[attempt % len(URLS)]
        profile = profiles[attempt % len(profiles)]
        try:
            scraper = cloudscraper.create_scraper(browser=profile)
            r = scraper.get(url, timeout=60)
            if r.status_code == 200 and "initialModels" in r.text:
                print(f"fetch OK on attempt {attempt + 1} ({url})")
                return r.text
            last_err = f"{url} -> HTTP {r.status_code}, len={len(r.text)}, no initialModels"
        except Exception as e:
            last_err = str(e)
        wait = 10 + random.random() * 20
        print(f"attempt {attempt + 1} failed ({last_err}), retrying in {wait:.0f}s")
        time.sleep(wait)
    raise RuntimeError(f"fetch failed after 12 attempts: {last_err}")
PUSH_RE = re.compile(r'self\.__next_f\.push\(\[1,"((?:\\.|[^"\\])*)"\]\)', re.S)


def decode_payload(html):
    """Unescape all __next_f.push JS string chunks and join them."""
    parts = []
    for m in PUSH_RE.finditer(html):
        raw = m.group(1)
        try:
            parts.append(json.loads('"' + raw + '"'))
        except Exception:
            parts.append(raw)
    return "".join(parts)


def extract_json_array(text, key='"initialModels":'):
    """Bracket-walk from the '[' after key to its matching ']'."""
    idx = text.find(key)
    if idx == -1:
        return None
    start = text.find("[", idx)
    if start == -1:
        return None
    depth, in_str, esc = 0, False, False
    for i in range(start, len(text)):
        c = text[i]
        if in_str:
            if esc:
                esc = False
            elif c == "\\":
                esc = True
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
                    return text[start:i + 1]
    return None


def get_models():
    html = fetch_html()
    arr = extract_json_array(decode_payload(html)) or extract_json_array(html)
    if not arr:
        raise RuntimeError("initialModels not found in page")
    models = json.loads(arr)
    return {m["id"]: m for m in models if isinstance(m, dict) and "id" in m}


# ---------------- helpers ----------------
def flatten_caps(model):
    caps = model.get("capabilities") or {}
    out = set()
    for k, v in (caps.get("inputCapabilities") or {}).items():
        if v:
            out.add(f"in:{k}")
    for k, v in (caps.get("outputCapabilities") or {}).items():
        if v:
            out.add(f"out:{k}")
    return out


def disp(model):
    return model.get("displayName") or model.get("publicName") or model.get("id")


def v(x):
    return "null" if x is None else str(x)


def arrow(a, b):
    return f"{v(a)} ➡️ {v(b)}"


def fmt_rank(model):
    r = model.get("rank")
    return "unranked" if r is None or r == UNRANKED else str(r)


def caps_line(model):
    caps = sorted(flatten_caps(model))
    return ", ".join(caps) if caps else "none"


def details_block(model, headline=None):
    """Full detail block for added/removed models."""
    lines = [headline or disp(model), model["id"]]
    for f in FIELDS:
        if model.get(f) is not None or f in ("organization",):
            lines.append(f"{f}: {v(model.get(f))}")
    lines.append(f"capabilities: {caps_line(model)}")
    lines.append(f"rank: {fmt_rank(model)}")
    return "\n".join(lines)


# ---------------- diff engine ----------------
def build_report(old, new):
    removed_ids = set(old) - set(new)
    added_ids = set(new) - set(old)
    common_ids = set(old) & set(new)

    # --- pair removed+added by publicName => ID rotations (kills noise) ---
    rotations, still_removed, still_added = [], [], set(added_ids)
    by_name_removed = {}
    for i in removed_ids:
        by_name_removed.setdefault(old[i].get("publicName"), []).append(i)
    for i in sorted(added_ids):
        pn = new[i].get("publicName")
        cands = by_name_removed.get(pn)
        if cands:
            j = cands.pop(0)
            rotations.append((old[j], new[i]))
            still_added.discard(i)
    for i in removed_ids:
        if all(o["id"] != i for o, _ in rotations):
            still_removed.append(old[i])

    # --- classify added ---
    new_models, hidden, variants = [], [], []
    old_names = {m.get("publicName") for m in old.values()}
    for i in sorted(still_added):
        m = new[i]
        if not m.get("organization"):
            hidden.append(m)
        elif m.get("publicName") in old_names:
            variants.append(m)
        else:
            new_models.append(m)

    # --- changed models (one block per model, all changed fields inside) ---
    name_upd, org_upd, cap_upd, rank_upd = [], [], [], []
    for i in sorted(common_ids):
        o, n = old[i], new[i]
        changes = [(f, o.get(f), n.get(f)) for f in FIELDS if o.get(f) != n.get(f)]
        gained = flatten_caps(n) - flatten_caps(o)
        lost = flatten_caps(o) - flatten_caps(n)
        rank_changed = TRACK_RANK and o.get("rank") != n.get("rank")
        if not changes and not gained and not lost and not rank_changed:
            continue
        lines = []
        no, nn = disp(o), disp(n)
        lines.append(arrow(no, nn) if no != nn else nn)
        lines.append(i)
        for f, ov, nv in changes:
            lines.append(f"{f}: {arrow(ov, nv)}")
        if gained or lost:
            lines.append("capabilities:")
            lines += [f"➕ {g}" for g in sorted(gained)]
            lines += [f"➖ {l}" for l in sorted(lost)]
        if rank_changed:
            lines.append(f"rank: {fmt_rank(o)} ➡️ {fmt_rank(n)}")
        block = "\n".join(lines)
        changed_fields = {f for f, _, _ in changes}
        if changed_fields & {"publicName", "displayName", "name"}:
            name_upd.append(block)
        elif "organization" in changed_fields:
            org_upd.append(block)
        elif gained or lost:
            cap_upd.append(block)
        else:
            rank_upd.append(block)

    # --- assemble sections ---
    sections = []
    if new_models:
        sections.append(("🆕 New models", [details_block(m) for m in new_models]))
    if hidden:
        sections.append(("🕵️ Hidden / stealth models",
                         [details_block(m) for m in hidden]))
    if variants:
        sections.append(("🧬 New variants", [details_block(m) for m in variants]))
    if name_upd:
        sections.append(("✏️ Name updates", name_upd))
    if org_upd:
        sections.append(("🏢 Organization updates", org_upd))
    if cap_upd:
        sections.append(("⚡ Capability updates", cap_upd))
    if rotations:
        sections.append(("🆔 ID rotations",
                         [f"{disp(n)}\n{o['id']} ➡️ {n['id']}" for o, n in rotations]))
    if rank_upd:
        sections.append(("📊 Rank updates", rank_upd))
    if still_removed:
        sections.append(("❌ Removed models",
                         [details_block(m) for m in still_removed]))
    if not sections:
        return None

    ts = datetime.datetime.now(datetime.timezone.utc).strftime("%d %b %Y, %H:%M UTC")
    parts = [f"📡 Arena Tracker — {ts}"]
    for title, blocks in sections:
        parts.append(f"{title} ({len(blocks)})\n" + "\n\n".join(blocks))
    return "\n\n".join(parts)


# ---------------- telegram ----------------
def send_telegram(text):
    if not TELEGRAM_TOKEN or not TELEGRAM_CHAT_ID:
        print(text)  # local dry-run
        return
    url = f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendMessage"
    r = requests.post(url, json={"chat_id": TELEGRAM_CHAT_ID, "text": text,
                                 "disable_web_page_preview": True}, timeout=30)
    if r.status_code != 200:
        print("Telegram error:", r.status_code, r.text[:300])


def split_message(text):
    chunks, cur = [], ""
    for para in text.split("\n\n"):
        piece = para if not cur else "\n\n" + para
        if len(cur) + len(piece) > MAX_MSG and cur:
            chunks.append(cur)
            cur = para
        else:
            cur += piece
    if cur:
        chunks.append(cur)
    return chunks


# ---------------- snapshot ----------------
def load_snapshot():
    if not os.path.exists(SNAPSHOT_FILE):
        return None
    with open(SNAPSHOT_FILE, encoding="utf-8") as f:
        return json.load(f)


def save_snapshot(models):
    with open(SNAPSHOT_FILE, "w", encoding="utf-8") as f:
        json.dump(models, f, ensure_ascii=False, indent=1, sort_keys=True)


# ---------------- main ----------------
def main():
    old = load_snapshot()
    new = get_models()
    print(f"old: {len(old) if old else 0} models, new: {len(new)} models")

    # sanity guard: never alert "everything removed" on a broken fetch
    if old and len(new) < max(50, len(old) // 2):
        send_telegram(f"⚠️ Fetch looks broken ({len(new)} models vs "
                      f"{len(old)} before). Skipping this run.")
        return

    if old is None:
        save_snapshot(new)
        send_telegram(f"✅ Arena tracker started\n{len(new)} models loaded "
                      f"as baseline. Alerts start from next change.")
        return

    report = build_report(old, new)
    if report:
        for chunk in split_message(report):
            send_telegram(chunk)
            time.sleep(1)
    else:
        print("no changes")
    save_snapshot(new)


if __name__ == "__main__":
    main()
