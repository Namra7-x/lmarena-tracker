#!/usr/bin/env python3
"""DesignArena registry tracker — diffs /api/registry and alerts on Telegram."""

import json
import os
import random
import time
from datetime import datetime, timezone

import requests

URL = "https://www.designarena.ai/api/registry"
SNAPSHOT = "design_snapshot.json"

TG_TOKEN = os.environ.get("TELEGRAM_TOKEN", "").strip()
TG_CHAT = os.environ.get("TELEGRAM_CHAT_ID", "").strip()

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")


# ---------- fetch ----------

def fetch_registry():
    last = "unknown"
    for attempt in range(6):
        try:
            r = requests.get(URL, headers={"User-Agent": UA, "Accept": "application/json"}, timeout=60)
            if r.status_code == 200:
                data = r.json()
                if isinstance(data, dict) and "models" in data:
                    print(f"fetch OK on attempt {attempt + 1}")
                    return data
                last = "no 'models' key in JSON"
            else:
                last = f"HTTP {r.status_code}"
        except Exception as e:
            last = str(e)
        wait = 5 + random.random() * 10
        print(f"attempt {attempt + 1} failed ({last}), retrying in {wait:.0f}s")
        time.sleep(wait)
    raise RuntimeError(f"fetch failed: {last}")


# ---------- normalize ----------

def norm_models(raw):
    out = {}
    for mid, m in raw.items():
        arenas = m.get("arenas") or {}
        out[mid] = {
            "displayName": m.get("displayName") or mid,
            "provider": m.get("provider"),
            "active": bool(m.get("active")),
            "openSource": bool(m.get("openSource")),
            "router": bool(m.get("router")),
            "vision": bool(m.get("vision")),
            "inputModalities": sorted(m.get("inputModalities") or []),
            "arenas": {k: sorted(v) for k, v in arenas.items() if isinstance(v, list)},
        }
    return out


def norm_providers(raw):
    return {pid: (p or {}).get("displayName") or pid for pid, p in (raw or {}).items()}


def norm_pricing(raw):
    """flatten pricing to {model_id: {'text.input': 1.5, 'image.perImage': 0.04, ...}}"""
    out = {}
    for mid, cats in (raw or {}).items():
        flat = {}
        for cat, fields in (cats or {}).items():
            for k, v in (fields or {}).items():
                flat[f"{cat}.{k}"] = v
        if flat:
            out[mid] = flat
    return out


# ---------- snapshot ----------

def load_snapshot():
    if not os.path.exists(SNAPSHOT):
        return None
    with open(SNAPSHOT, encoding="utf-8") as f:
        return json.load(f)


def save_snapshot(models, providers, pricing):
    with open(SNAPSHOT, "w", encoding="utf-8") as f:
        json.dump({"models": models, "providers": providers, "pricing": pricing},
                  f, indent=2, sort_keys=True)


# ---------- diff ----------

def diff(old, new):
    om, op, opz = old["models"], old.get("providers", {}), old.get("pricing", {})
    nm, np_, npz = new["models"], new.get("providers", {}), new.get("pricing", {})

    d = {"added": [], "removed": [], "renamed": [], "provider": [], "active_on": [],
         "active_off": [], "categories": [], "caps": [], "new_providers": [],
         "price_new": [], "price_changed": []}

    for mid in sorted(set(nm) - set(om)):
        m = nm[mid]
        cats = ", ".join(f"{k}: {', '.join(v)}" for k, v in m["arenas"].items()) or "none"
        d["added"].append((mid, m, cats))

    for mid in sorted(set(om) - set(nm)):
        d["removed"].append((mid, om[mid]))

    for mid in sorted(set(om) & set(nm)):
        o, n = om[mid], nm[mid]
        if o["displayName"] != n["displayName"]:
            d["renamed"].append((mid, o["displayName"], n["displayName"]))
        if o["provider"] != n["provider"]:
            d["provider"].append((mid, n["displayName"], o["provider"], n["provider"]))
        if o["active"] != n["active"]:
            (d["active_on"] if n["active"] else d["active_off"]).append((mid, n["displayName"]))

        # category (arena) changes
        cat_changes = []
        for cat in sorted(set(o["arenas"]) | set(n["arenas"])):
            added = sorted(set(n["arenas"].get(cat, [])) - set(o["arenas"].get(cat, [])))
            removed = sorted(set(o["arenas"].get(cat, [])) - set(n["arenas"].get(cat, [])))
            if added:
                cat_changes.append(f"➕ {cat}: {', '.join(added)}")
            if removed:
                cat_changes.append(f"➖ {cat}: {', '.join(removed)}")
        if cat_changes:
            d["categories"].append((mid, n["displayName"], cat_changes))

        # capability changes
        cap_changes = []
        for field, label in [("openSource", "openSource"), ("router", "router"), ("vision", "vision")]:
            if o[field] != n[field]:
                cap_changes.append(f"{label}: {o[field]} ➡️ {n[field]}")
        if o["inputModalities"] != n["inputModalities"]:
            cap_changes.append(f"inputModalities: {', '.join(o['inputModalities']) or 'none'} "
                               f"➡️ {', '.join(n['inputModalities']) or 'none'}")
        if cap_changes:
            d["caps"].append((mid, n["displayName"], cap_changes))

    for pid in sorted(set(np_) - set(op)):
        d["new_providers"].append((pid, np_[pid]))

    for mid in sorted(set(npz) - set(opz)):
        d["price_new"].append((mid, npz[mid]))
    for mid in sorted(set(npz) & set(opz)):
        changes = []
        for k in sorted(set(npz[mid]) | set(opz[mid])):
            ov, nv = opz[mid].get(k), npz[mid].get(k)
            if ov != nv:
                changes.append(f"{k}: {ov} ➡️ {nv}")
        if changes:
            d["price_changed"].append((mid, changes))

    return d


def has_changes(d):
    return any(d.values())


# ---------- message ----------

LIMIT = 15

def build_message(d, models):
    now = datetime.now(timezone.utc).strftime("%d %b %Y, %H:%M UTC")
    lines = [f"🎨 DesignArena Tracker — {now}", ""]

    def section(title, items, render):
        if not items:
            return
        lines.append(f"{title} ({len(items)})")
        for it in items[:LIMIT]:
            lines.extend(render(it))
        if len(items) > LIMIT:
            lines.append(f"… +{len(items) - LIMIT} more")
        lines.append("")

    section("🆕 New models", d["added"], lambda it: [
        f"• {it[1]['displayName']} ({it[0]})",
        f"  provider: {it[1]['provider']} | active: {'✅' if it[1]['active'] else '❌'} "
        f"| open source: {'✅' if it[1]['openSource'] else '❌'}",
        f"  categories: {it[2]}",
    ])
    section("❌ Removed models", d["removed"], lambda it: [
        f"• {it[1]['displayName']} ({it[0]}) — provider: {it[1]['provider']}",
    ])
    section("✏️ Name updates", d["renamed"], lambda it: [
        f"• {it[1]} ➡️ {it[2]}", f"  {it[0]}",
    ])
    section("🏢 Provider updates", d["provider"], lambda it: [
        f"• {it[1]} ({it[0]}): {it[2]} ➡️ {it[3]}",
    ])
    section("🟢 Activated (now live)", d["active_on"], lambda it: [
        f"• {it[1]} ({it[0]})",
    ])
    section("🔴 Deactivated (pulled)", d["active_off"], lambda it: [
        f"• {it[1]} ({it[0]})",
    ])
    section("🏟️ Category updates", d["categories"], lambda it: [
        f"• {it[1]} ({it[0]})", *[f"  {c}" for c in it[2]],
    ])
    section("⚡ Capability updates", d["caps"], lambda it: [
        f"• {it[1]} ({it[0]})", *[f"  {c}" for c in it[2]],
    ])
    section("🏭 New providers", d["new_providers"], lambda it: [
        f"• {it[1]} ({it[0]})",
    ])
    section("💲 Pricing added", d["price_new"], lambda it: [
        f"• {it[0]}: " + ", ".join(f"{k}={v}" for k, v in list(it[1].items())[:4]),
    ])
    section("💲 Pricing updates", d["price_changed"], lambda it: [
        f"• {it[0]}", *[f"  {c}" for c in it[1]],
    ])

    return "\n".join(lines).strip()


# ---------- telegram ----------

def send_telegram(text):
    if not TG_TOKEN or not TG_CHAT:
        print("--- dry run (no Telegram secrets) ---")
        print(text)
        return
    for i in range(0, len(text), 4000):
        chunk = text[i:i + 4000]
        r = requests.post(
            f"https://api.telegram.org/bot{TG_TOKEN}/sendMessage",
            json={"chat_id": TG_CHAT, "text": chunk, "disable_web_page_preview": True},
            timeout=30,
        )
        if r.status_code != 200:
            print("telegram error:", r.status_code, r.text[:300])
        time.sleep(1)
    print("telegram sent")


# ---------- main ----------

def main():
    old = load_snapshot()
    data = fetch_registry()
    new = {
        "models": norm_models(data.get("models", {})),
        "providers": norm_providers(data.get("providers", {})),
        "pricing": norm_pricing(data.get("pricing", {})),
    }
    print(f"models: {len(new['models'])}, providers: {len(new['providers'])}, "
          f"priced: {len(new['pricing'])}")

    if old is None:
        save_snapshot(**new)
        print("baseline snapshot saved — no alert (first run)")
        return

    d = diff(old, new)
    if not has_changes(d):
        print("no changes")
        return

    msg = build_message(d, new["models"])
    send_telegram(msg)
    save_snapshot(**new)
    print("snapshot updated")


if __name__ == "__main__":
    main()
