#!/usr/bin/env python3
import subprocess
import json
import os
import sys
import requests
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
    """Fetch models using the EXACT method that works in Termux"""
    
    print("📥 Fetching models using curl method...")
    
    try:
        # Use the EXACT command that worked in Termux
        # curl -s https://lmarena.ai | tr ',' '\n' | grep publicName | cut -d'"' -f4
        
        cmd = """
        curl -s -L https://lmarena.ai \
        -H 'User-Agent: Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36' \
        -H 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' \
        | tr ',' '\n' \
        | grep publicName \
        | cut -d'"' -f4 \
        | sort -u
        """
        
        result = subprocess.run(
            cmd,
            shell=True,
            capture_output=True,
            text=True,
            timeout=60
        )
        
        if result.returncode == 0:
            models = result.stdout.strip().split('\n')
            # Filter out empty lines
            models = [m.strip() for m in models if m.strip()]
            
            if models:
                model_set = set(models)
                print(f"✅ Found {len(model_set)} models")
                
                # Show first 5 as sample
                print("   Sample models:")
                for m in sorted(model_set)[:5]:
                    print(f"     • {m}")
                print(f"     ... and {len(model_set) - 5} more")
                
                return model_set
            else:
                print("⚠️  No models extracted")
        else:
            print(f"❌ Command failed with code: {result.returncode}")
            print(f"   Error: {result.stderr}")
            
    except subprocess.TimeoutExpired:
        print("❌ Timeout after 60 seconds")
    except Exception as e:
        print(f"❌ Error: {e}")
    
    # Fallback: Use cached data if available
    print("\n⚠️  Fetch failed, checking cache...")
    if os.path.exists(MODELS_FILE):
        try:
            with open(MODELS_FILE, 'r') as f:
                cached = set(json.load(f))
                print(f"✅ Using {len(cached)} cached models")
                return cached
        except:
            pass
    
    print("❌ No cached data available")
    return set()

def load_known_models():
    """Load previously tracked models"""
    if os.path.exists(MODELS_FILE):
        try:
            with open(MODELS_FILE, 'r') as f:
                return set(json.load(f))
        except:
            return set()
    return set()

def save_models(models):
    """Save models to file"""
    try:
        with open(MODELS_FILE, 'w') as f:
            json.dump(sorted(list(models)), f, indent=2)
        print(f"💾 Saved {len(models)} models")
    except Exception as e:
        print(f"❌ Save error: {e}")

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
    print("="*60 + "\n")
    
    # Fetch current models
    current_models = get_current_models()
    
    if not current_models:
        print("\n❌ Could not fetch models")
        known = load_known_models()
        
        if not known:
            print("   First run - will initialize on next successful fetch")
        else:
            print("   Will retry on next run")
        
        # Exit cleanly (don't mark workflow as failed)
        sys.exit(0)
    
    print(f"\n✅ Total: {len(current_models)} models")
    
    # Load known models
    known_models = load_known_models()
    
    # First run
    if not known_models:
        print("\n📝 FIRST RUN - Initializing")
        save_models(current_models)
        
        msg = (
            f"🤖 <b>LMArena Tracker Started!</b>\n\n"
            f"📊 Tracking <b>{len(current_models)}</b> models\n"
            f"⏰ {datetime.utcnow().strftime('%Y-%m-%d %H:%M:%S UTC')}\n\n"
            f"✅ You'll be notified when:\n"
            f"  • New models are added\n"
            f"  • Anonymous models are removed/renamed\n\n"
            f"🔗 https://lmarena.ai"
        )
        send_telegram(msg)
        print("✅ Initialization complete")
        return
    
    print(f"📊 Previous run: {len(known_models)} models")
    
    # Find changes
    added = current_models - known_models
    removed = known_models - current_models
    
    print(f"   New: {len(added)}")
    print(f"   Removed: {len(removed)}")
    
    # Report ADDED models
    if added:
        print(f"\n🆕 NEW MODELS DETECTED ({len(added)}):")
        for m in sorted(added):
            print(f"   + {m}")
        
        msg = f"🆕 <b>NEW MODELS ADDED</b>\n\n"
        msg += f"<b>Count:</b> {len(added)}\n\n"
        msg += format_model_list(added)
        msg += f"\n\n⏰ {datetime.utcnow().strftime('%Y-%m-%d %H:%M:%S UTC')}"
        msg += "\n🔗 Try them: https://lmarena.ai"
        send_telegram(msg)
    
    # Report REMOVED models (likely anonymous/stealth)
    if removed:
        print(f"\n❌ MODELS REMOVED ({len(removed)}):")
        for m in sorted(removed):
            print(f"   - {m}")
        
        msg = f"❌ <b>MODELS REMOVED</b>\n\n"
        msg += f"<b>Count:</b> {len(removed)}\n\n"
        msg += f"<i>⚠️ These were likely anonymous/stealth models that got renamed or removed from testing:</i>\n\n"
        msg += format_model_list(removed)
        msg += f"\n\n⏰ {datetime.utcnow().strftime('%Y-%m-%d %H:%M:%S UTC')}"
        send_telegram(msg)
    
    if not added and not removed:
        print("\n✅ No changes - all models unchanged")
    
    # Save updated list
    save_models(current_models)
    
    print("\n" + "="*60)
    print(f"📊 TRACKING: {len(current_models)} models")
    print(f"   Added: {len(added)} | Removed: {len(removed)}")
    print("="*60)
    print("✅ Run complete\n")

if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n⚠️  Stopped by user")
        sys.exit(0)
    except Exception as e:
        print(f"\n❌ ERROR: {e}")
        import traceback
        traceback.print_exc()
        sys.exit(0)
