#!/usr/bin/env python3
import requests
import re
import json
import os
import sys
from datetime import datetime

# Get credentials from environment
TELEGRAM_BOT_TOKEN = os.environ.get('TELEGRAM_BOT_TOKEN')
TELEGRAM_CHAT_ID = os.environ.get('TELEGRAM_CHAT_ID')
MODELS_FILE = "known_models.json"

def send_telegram(message):
    """Send notification to Telegram"""
    if not TELEGRAM_BOT_TOKEN or not TELEGRAM_CHAT_ID:
        print("⚠️  Telegram credentials not configured")
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
            print("✅ Telegram notification sent")
        else:
            print(f"❌ Telegram error: {response.text}")
    except Exception as e:
        print(f"❌ Error sending Telegram: {e}")

def get_current_models():
    """Fetch current model list from lmarena.ai"""
    try:
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
        }
        response = requests.get("https://lmarena.ai", headers=headers, timeout=30)
        
        # Extract all publicName fields
        models = re.findall(r'"publicName":"([^"]+)"', response.text)
        
        # Remove duplicates and return as set
        return set(models)
        
    except Exception as e:
        print(f"❌ Error fetching models: {e}")
        return set()

def load_known_models():
    """Load previously seen models from file"""
    if os.path.exists(MODELS_FILE):
        try:
            with open(MODELS_FILE, 'r') as f:
                data = json.load(f)
                return set(data)
        except Exception as e:
            print(f"⚠️  Error loading known models: {e}")
            return set()
    return set()

def save_models(models):
    """Save models to file"""
    try:
        with open(MODELS_FILE, 'w') as f:
            json.dump(sorted(list(models)), f, indent=2)
        print(f"💾 Saved {len(models)} models to {MODELS_FILE}")
    except Exception as e:
        print(f"❌ Error saving models: {e}")

def format_model_list(models, max_display=20):
    """Format model list for display"""
    models_sorted = sorted(models)
    if len(models_sorted) <= max_display:
        return "\n".join(f"  • <code>{m}</code>" for m in models_sorted)
    else:
        shown = models_sorted[:max_display]
        remaining = len(models_sorted) - max_display
        result = "\n".join(f"  • <code>{m}</code>" for m in shown)
        result += f"\n  ... and {remaining} more"
        return result

def main():
    print("="*60)
    print("🤖 LMARENA MODEL TRACKER")
    print("="*60)
    print(f"⏰ Run time: {datetime.now().strftime('%Y-%m-%d %H:%M:%S UTC')}")
    print("="*60 + "\n")
    
    # Fetch current models
    print("📥 Fetching models from lmarena.ai...")
    current_models = get_current_models()
    
    if not current_models:
        print("❌ Failed to fetch models. Exiting.")
        sys.exit(1)
    
    print(f"✅ Fetched {len(current_models)} models\n")
    
    # Load known models
    known_models = load_known_models()
    
    if not known_models:
        print("📝 First run - initializing model list")
        save_models(current_models)
        send_telegram(
            f"🤖 <b>LMArena Tracker Initialized!</b>\n\n"
            f"📊 Tracking {len(current_models)} models\n"
            f"⏰ {datetime.now().strftime('%Y-%m-%d %H:%M:%S UTC')}\n\n"
            f"You'll be notified of any changes!"
        )
        print(f"✅ Initialized with {len(current_models)} models")
        return
    
    print(f"📊 Previously tracked: {len(known_models)} models\n")
    
    # Find changes
    added_models = current_models - known_models
    removed_models = known_models - current_models
    
    # Report ADDED models
    if added_models:
        print(f"🆕 NEW MODELS DETECTED: {len(added_models)}")
        for model in sorted(added_models):
            print(f"   + {model}")
        
        message = f"🆕 <b>NEW MODELS ADDED ({len(added_models)})</b>\n\n"
        message += format_model_list(added_models)
        message += f"\n\n⏰ {datetime.now().strftime('%Y-%m-%d %H:%M:%S UTC')}"
        message += f"\n🔗 Check them out: https://lmarena.ai"
        
        send_telegram(message)
        print()
    
    # Report REMOVED models
    if removed_models:
        print(f"❌ MODELS REMOVED: {len(removed_models)}")
        for model in sorted(removed_models):
            print(f"   - {model}")
        
        message = f"❌ <b>MODELS REMOVED ({len(removed_models)})</b>\n\n"
        message += "<i>These were likely anonymous/stealth models that got renamed or removed:</i>\n\n"
        message += format_model_list(removed_models)
        message += f"\n\n⏰ {datetime.now().strftime('%Y-%m-%d %H:%M:%S UTC')}"
        
        send_telegram(message)
        print()
    
    # No changes
    if not added_models and not removed_models:
        print("✅ No changes detected - all models unchanged")
    
    # Save updated model list
    save_models(current_models)
    
    print("\n" + "="*60)
    print(f"📊 SUMMARY: Tracking {len(current_models)} models")
    print(f"   Added: {len(added_models)} | Removed: {len(removed_models)}")
    print("="*60)

if __name__ == "__main__":
    main()
