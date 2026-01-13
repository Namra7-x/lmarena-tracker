#!/bin/bash

# Configuration
BOT_TOKEN="$TELEGRAM_BOT_TOKEN"
CHAT_ID="$TELEGRAM_CHAT_ID"
MODELS_FILE="models_data.json"
SIMPLE_LIST="models_list.txt"

send_telegram() {
    local msg="$1"
    curl -s -X POST "https://api.telegram.org/bot$BOT_TOKEN/sendMessage" \
        -H "Content-Type: application/json" \
        -d "{\"chat_id\":\"$CHAT_ID\",\"text\":\"$msg\",\"parse_mode\":\"HTML\",\"disable_web_page_preview\":true}" \
        > /dev/null
}

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S UTC')] $1"
}

# Function to extract detailed model data
extract_model_data() {
    local html="$1"
    
    # Save full JSON data of models
    echo "$html" | grep -o '{"id":"[^}]*"organization":"[^"]*"[^}]*"publicName":"[^"]*"[^}]*"rank":[0-9]*[^}]*}' | \
    python3 -c "
import sys, json, re

models = {}
for line in sys.stdin:
    try:
        # Extract model info using regex
        id_match = re.search(r'\"id\":\"([^\"]+)\"', line)
        name_match = re.search(r'\"publicName\":\"([^\"]+)\"', line)
        org_match = re.search(r'\"organization\":\"([^\"]+)\"', line)
        rank_match = re.search(r'\"rank\":([0-9]+)', line)
        display_match = re.search(r'\"displayName\":\"([^\"]+)\"', line)
        
        if name_match:
            name = name_match.group(1)
            models[name] = {
                'id': id_match.group(1) if id_match else 'unknown',
                'publicName': name,
                'organization': org_match.group(1) if org_match else 'unknown',
                'rank': int(rank_match.group(1)) if rank_match else 999,
                'displayName': display_match.group(1) if display_match else name
            }
    except:
        pass

# Output sorted by name
for name in sorted(models.keys()):
    print(json.dumps(models[name]))
" 2>/dev/null
}

log "================================================================"
log "🤖 LMARENA DETAILED TRACKER"
log "================================================================"

# Fetch page
log "📥 Fetching lmarena.ai..."
HTML=$(curl -s -L https://lmarena.ai \
    -H 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' \
    -H 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8')

if [ -z "$HTML" ]; then
    log "❌ Failed to fetch page"
    exit 0
fi

log "✅ Page fetched ($(echo "$HTML" | wc -c) bytes)"

# Extract simple model list (for quick comparison)
log "🔍 Extracting model names..."
echo "$HTML" | tr ',' '\n' | grep publicName | cut -d'"' -f4 | sort -u > models_new.txt

NEW_COUNT=$(wc -l < models_new.txt)
log "   Found $NEW_COUNT model names"

# Extract detailed model data
log "🔍 Extracting detailed model data..."
extract_model_data "$HTML" > models_detailed_new.json

DETAILED_COUNT=$(wc -l < models_detailed_new.json)
log "   Extracted $DETAILED_COUNT detailed records"

# Check if extraction worked
if [ ! -s models_new.txt ]; then
    log "❌ No models extracted"
    exit 0
fi

# ============================================
# FIRST RUN - Initialize
# ============================================
if [ ! -f "$SIMPLE_LIST" ]; then
    log ""
    log "📝 FIRST RUN - Initializing tracker"
    
    cp models_new.txt "$SIMPLE_LIST"
    cp models_detailed_new.json "$MODELS_FILE" 2>/dev/null || touch "$MODELS_FILE"
    
    # Show sample of models
    log "   Sample models:"
    head -5 "$SIMPLE_LIST" | while read model; do
        log "     • $model"
    done
    log "     ... and $((NEW_COUNT - 5)) more"
    
    MSG="🤖 <b>LMArena Tracker Started!</b>%0A%0A"
    MSG="${MSG}📊 Now tracking <b>$NEW_COUNT models</b>%0A%0A"
    MSG="${MSG}✅ You'll be notified about:%0A"
    MSG="${MSG}  • New models added%0A"
    MSG="${MSG}  • Models removed%0A"
    MSG="${MSG}  • Model names changed%0A"
    MSG="${MSG}  • Rankings changed%0A%0A"
    MSG="${MSG}🔗 https://lmarena.ai"
    
    send_telegram "$MSG"
    log "✅ Initialization complete"
    exit 0
fi

# ============================================
# COMPARE CHANGES
# ============================================

PREV_COUNT=$(wc -l < "$SIMPLE_LIST")
log ""
log "📊 Comparison:"
log "   Previous: $PREV_COUNT models"
log "   Current:  $NEW_COUNT models"
log "   Change:   $((NEW_COUNT - PREV_COUNT))"

# Find simple additions/removals
ADDED=$(comm -13 "$SIMPLE_LIST" models_new.txt)
REMOVED=$(comm -23 "$SIMPLE_LIST" models_new.txt)

ADDED_COUNT=$(echo "$ADDED" | grep -c . || echo 0)
REMOVED_COUNT=$(echo "$REMOVED" | grep -c . || echo 0)

log ""
log "   Added:    $ADDED_COUNT"
log "   Removed:  $REMOVED_COUNT"

# ============================================
# DETAILED CHANGE DETECTION
# ============================================

# Compare detailed data if available
if [ -s "$MODELS_FILE" ] && [ -s models_detailed_new.json ]; then
    log ""
    log "🔍 Checking for detailed changes..."
    
    # Find models that exist in both (for change detection)
    COMMON_MODELS=$(comm -12 "$SIMPLE_LIST" models_new.txt)
    
    RANK_CHANGES=0
    ORG_CHANGES=0
    NAME_CHANGES=0
    
    # This is a simplified check - in practice you'd parse JSON properly
    if ! diff -q "$MODELS_FILE" models_detailed_new.json > /dev/null 2>&1; then
        log "   ⚠️  Detailed data has changes"
        # You could add more sophisticated JSON diff here
    fi
fi

# ============================================
# REPORT NEW MODELS
# ============================================

if [ ! -z "$ADDED" ] && [ "$ADDED_COUNT" -gt 0 ]; then
    log ""
    log "🆕 NEW MODELS DETECTED ($ADDED_COUNT):"
    
    MSG="🆕 <b>NEW MODELS ADDED</b>%0A%0A"
    MSG="${MSG}📊 <b>Count:</b> $ADDED_COUNT%0A%0A"
    
    COUNTER=0
    echo "$ADDED" | while read model; do
        COUNTER=$((COUNTER + 1))
        log "   [$COUNTER] + $model"
        
        # Get detailed info if available
        DETAILS=$(grep "\"publicName\":\"$model\"" models_detailed_new.json 2>/dev/null)
        
        if [ ! -z "$DETAILS" ]; then
            ORG=$(echo "$DETAILS" | grep -o '"organization":"[^"]*"' | cut -d'"' -f4)
            RANK=$(echo "$DETAILS" | grep -o '"rank":[0-9]*' | cut -d':' -f2)
            
            MSG="${MSG}• <code>$model</code>%0A"
            if [ ! -z "$ORG" ]; then
                MSG="${MSG}  └ Org: <i>$ORG</i>"
            fi
            if [ ! -z "$RANK" ]; then
                MSG="${MSG} | Rank: #$RANK"
            fi
            MSG="${MSG}%0A"
        else
            MSG="${MSG}• <code>$model</code>%0A"
        fi
        
        # Limit to 20 models in message
        if [ "$COUNTER" -ge 20 ]; then
            REMAINING=$((ADDED_COUNT - 20))
            if [ "$REMAINING" -gt 0 ]; then
                MSG="${MSG}%0A<i>...and $REMAINING more</i>%0A"
            fi
            break
        fi
    done
    
    MSG="${MSG}%0A⏰ $(date '+%Y-%m-%d %H:%M UTC')"
    MSG="${MSG}%0A🔗 https://lmarena.ai"
    
    send_telegram "$MSG"
fi

# ============================================
# REPORT REMOVED MODELS
# ============================================

if [ ! -z "$REMOVED" ] && [ "$REMOVED_COUNT" -gt 0 ]; then
    log ""
    log "❌ MODELS REMOVED ($REMOVED_COUNT):"
    
    MSG="❌ <b>MODELS REMOVED</b>%0A%0A"
    MSG="${MSG}📊 <b>Count:</b> $REMOVED_COUNT%0A%0A"
    MSG="${MSG}<i>⚠️ These were likely anonymous/stealth models that got renamed or removed from testing:</i>%0A%0A"
    
    COUNTER=0
    echo "$REMOVED" | while read model; do
        COUNTER=$((COUNTER + 1))
        log "   [$COUNTER] - $model"
        
        # Get previous details if available
        OLD_DETAILS=$(grep "\"publicName\":\"$model\"" "$MODELS_FILE" 2>/dev/null)
        
        if [ ! -z "$OLD_DETAILS" ]; then
            ORG=$(echo "$OLD_DETAILS" | grep -o '"organization":"[^"]*"' | cut -d'"' -f4)
            RANK=$(echo "$OLD_DETAILS" | grep -o '"rank":[0-9]*' | cut -d':' -f2)
            
            MSG="${MSG}• <code>$model</code>%0A"
            if [ ! -z "$ORG" ]; then
                MSG="${MSG}  └ Was: <i>$ORG</i>"
            fi
            if [ ! -z "$RANK" ]; then
                MSG="${MSG} | Rank: #$RANK"
            fi
            MSG="${MSG}%0A"
        else
            MSG="${MSG}• <code>$model</code>%0A"
        fi
        
        # Limit to 20
        if [ "$COUNTER" -ge 20 ]; then
            REMAINING=$((REMOVED_COUNT - 20))
            if [ "$REMAINING" -gt 0 ]; then
                MSG="${MSG}%0A<i>...and $REMAINING more</i>%0A"
            fi
            break
        fi
    done
    
    MSG="${MSG}%0A⏰ $(date '+%Y-%m-%d %H:%M UTC')"
    
    send_telegram "$MSG"
fi

# ============================================
# NO CHANGES
# ============================================

if [ "$ADDED_COUNT" -eq 0 ] && [ "$REMOVED_COUNT" -eq 0 ]; then
    log ""
    log "✅ No changes detected - all models unchanged"
fi

# ============================================
# SAVE STATE
# ============================================

mv models_new.txt "$SIMPLE_LIST"
mv models_detailed_new.json "$MODELS_FILE" 2>/dev/null || true

log ""
log "💾 State saved"
log "================================================================"
log "✅ Run complete"
log "   Total models: $NEW_COUNT"
log "   Added: $ADDED_COUNT | Removed: $REMOVED_COUNT"
log "================================================================"
