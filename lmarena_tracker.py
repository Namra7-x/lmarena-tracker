#!/usr/bin/env python3
import requests
import re
import json
import os
import sys
from datetime import datetime

# Configuration
TELEGRAM_BOT_TOKEN = os.environ.get('TELEGRAM_BOT_TOKEN', '')
TELEGRAM_CHAT_ID = os.environ.get('TELEGRAM_CHAT_ID', '')
MODELS_FILE = "known_models.json"

def send_telegram(message):
    """Send notification to Telegram"""
    if not TELEGRAM_BOT_TOKEN or not TELEGRAM_CHAT_ID:
        print("⚠️  Telegram not configured")
        return
    
    url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage"
    payload = {
        "chat_id": TELEGRAM_CHAT_ID,
        "text": message,
        "parse_mode": "HTML",
        "disable_web_page_preview": True
    }
    try:
        response = requests.post(url, json=payload, timeout=10)
        if response.status_code == 200:
            print("✅ Telegram sent")
        else:
            print(f"❌ Telegram error: {response.status_code}")
    except Exception as e:
        print(f"❌ Telegram error: {e}")

def get_current_models():
    """
    Fetch models from lmarena.ai
    This mimics: curl -s https://lmarena.ai | tr ',' '\n' | grep publicName | cut -d'"' -f4
    """
    
    print("📥 Fetching models from lmarena.ai...")
    
    try:
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
            "Accept-Encoding": "gzip, deflate, br",
            "DNT": "1",
            "Connection": "keep-alive",
            "Upgrade-Insecure-Requests": "1"
        }
        
        # Fetch the page
        response = requests.get(
            "https://lmarena.ai",
            headers=headers,
            timeout=30,
            allow_redirects=True
        )
        
        print(f"   Status: {response.status_code}")
        print(f"   Content size: {len(response.text)} bytes")
        
        if response.status_code != 200:
            print(f"❌ HTTP error: {response.status_code}")
            return set()
        
        # Method 1: Extract using regex (same as grep publicName)
        # This finds all "publicName":"something" patterns
        models = re.findall(r'"publicName"\s*:\s*"([^"]+)"', response.text)
        
        if models:
            unique_models = set(models)
            print(f"✅ Found {len(unique_models)} unique models")
            
            # Show sample
            sample = sorted(unique_models)[:5]
            print("   Sample:")
            for m in sample:
                print(f"     • {m}")
            
            return unique_models
        
        # Method 2: Try alternative pattern
        print("   Trying alternative pattern...")
        models = re.findall(r'publicName["\s:]+([a-zA-Z0-9\-\.\_]+)', response.text, re.IGNORECASE)
        
        if models:
            unique_models = set(models)
            print(f"✅ Found {len(unique_models)} models (alt method)")
            return unique_models
        
        print("⚠️  No models found in page")
        print("   Page might be using different structure")
        
        # Debug: Save page content for inspection
        with open('debug_page.html', 'w', encoding='utf-8') as f:
            f.write(response.text[:5000])  # First 5000 chars
        print("   Saved debug_page.html for inspection")
        
        return set()
        
    except requests.exceptions.RequestException as e:
        print(f"❌ Network error: {e}")
        return set()
    except Exception as e:
        print(f"❌ Error: {e}")
        import traceback
        traceback.print_exc()
        return set()

def load_known_models():
    """Load previously tracked models"""
    if os.path.exists(MODELS_FILE):
        try:
            with open(MODELS_FILE, 'r') as f:
                return set(json.load(f))
        except Exception as e:
            print(f"⚠️  Error loading cache: {e}")
            return set()
    return set()

def save_models(models):
    """Save models to file"""
    try:
        with open(MODELS_FILE, 'w') as f:
            json.dump(sorted(list(models)), f, indent=2)
        print(f"💾 Saved {len(models)} models to {MODELS_FILE}")
        return True
    except Exception as e:
        print(f"❌ Save error: {e}")
        return False

def format_model_list(models, max_display=15):
    """Format model list for Telegram"""
    models_sorted = sorted(models)
    if len(models_sorted) <= max_display:
        return "\n".join(f"• <code>{m}</code>" for m in models_sorted)
    else:
        shown = models_sorted[:max_display]
        remaining = len(models_sorted) - max_display
        result = "\n".join(f"• <code>{m}</code>" for m in shown)
        result += f"\n\n<i>... and {remaining} more</i>"
        return result

def main():
    print("="*60)
    print("🤖 LMARENA MODEL TRACKER")
    print("="*60)
    print(f"⏰ {datetime.utcnow().strftime('%Y-%m-%d %H:%M:%S UTC')}")
    print(f"🔑 Telegram: {'Configured' if TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID else 'Not configured'}")
    print("="*60 + "\n")
    
    # Fetch current models
    current_models = get_current_models()
    
    if not current_models:
        print("\n❌ Could not fetch models")
        
        # Check if we have cached data
        known = load_known_models()
        
        if not known:
            print("   This is the first run")
            print("   The tracker will initialize on next successful fetch")
            print("   Exiting cleanly - will retry on next scheduled run")
        else:
            print("   Using cached data from previous run")
            print(f"   Cached models: {len(known)}")
            print("   Will retry fetching on next run")
        
        sys.exit(0)  # Exit cleanly
    
    print(f"\n✅ Successfully fetched {len(current_models)} models")
    
    # Load known models
    known_models = load_known_models()
    
    # First run - initialize
    if not known_models:
        print("\n📝 FIRST RUN - Initializing tracker")
        
        if save_models(current_models):
            msg = (
                f"🤖 <b>LMArena Tracker Initialized!</b>\n\n"
                f"📊 Now tracking <b>{len(current_models)}</b> models\n"
                f"⏰ {datetime.utcnow().strftime('%Y-%m-%d %H:%M:%S UTC')}\n\n"
                f"✅ You'll be notified when:\n"
                f"  • New models added (including anonymous ones)\n"
                f"  • Models removed/renamed\n\n"
                f"🔗 https://lmarena.ai"
            )
            send_telegram(msg)
            print("✅ Initialization complete")
        else:
            print("❌ Failed to save initial data")
        
        return
    
    print(f"📊 Previous: {len(known_models)} models")
    
    # Find changes
    added = current_models - known_models
    removed = known_models - current_models
    
    print(f"   Added: {len(added)}")
    print(f"   Removed: {len(removed)}")
    
    # Report ADDED
    if added:
        print(f"\n🆕 NEW MODELS ({len(added)}):")
        for m in sorted(added):
            print(f"   + {m}")
        
        msg = f"🆕 <b>NEW MODELS ADDED</b>\n\n"
        msg += f"<b>Count:</b> {len(added)}\n\n"
        msg += format_model_list(added)
        msg += f"\n\n⏰ {datetime.utcnow().strftime('%Y-%m-%d %H:%M:%S UTC')}"
        msg += "\n🔗 https://lmarena.ai"
        send_telegram(msg)
    
    # Report REMOVED
    if removed:
        print(f"\n❌ REMOVED MODELS ({len(removed)}):")
        for m in sorted(removed):
            print(f"   - {m}")
        
        msg = f"❌ <b>MODELS REMOVED</b>\n\n"
        msg += f"<b>Count:</b> {len(removed)}\n\n"
        msg += f"<i>⚠️ Likely anonymous/stealth models renamed or removed:</i>\n\n"
        msg += format_model_list(removed)
        msg += f"\n\n⏰ {datetime.utcnow().strftime('%Y-%m-%d %H:%M:%S UTC')}"
        send_telegram(msg)
    
    if not added and not removed:
        print("\n✅ No changes detected")
    
    # Save updated list
    save_models(current_models)
    
    print("\n" + "="*60)
    print(f"📊 TRACKING: {len(current_models)} models")
    print(f"   Added: {len(added)} | Removed: {len(removed)}")
    print("="*60)
    print("✅ Completed successfully\n")

if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n⚠️  Interrupted")
        sys.exit(0)
    except Exception as e:
        print(f"\n❌ FATAL ERROR: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(0)
