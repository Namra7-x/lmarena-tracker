#!/bin/bash

# Configuration
BOT_TOKEN="$TELEGRAM_BOT_TOKEN"
CHAT_ID="$TELEGRAM_CHAT_ID"
MODELS_FILE="models_data.json"
SIMPLE_LIST="models_list.txt"

send_telegram() {
    local msg="$1"
    # Use proper URL encoding
    curl -s -X POST "https://api.telegram.org/bot$BOT_TOKEN/sendMessage" \
        -d "chat_id=$CHAT_ID" \
        -d "parse_mode=HTML" \
        -d "disable_web_page_preview=true" \
        --data-urlencode "text=$msg" \
        > /dev/null
}

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S UTC')] $1"
}

# Function to extract detailed model data
extract_model_data() {
    local html="$1"
    
    echo "$html" | grep -o '{"id":"[^}]*"organization":"[^"]*"[^}]*"publicName":"[^"]*"[^}]*"rank":[0-9]*[^}]*}' | \
    python3 -c "
import sys, json, re

models = {}
for line in sys.stdin:
    try:
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

# Extract simple model list
log "🔍 Extracting model names..."
echo "$HTML" | tr ',' '\n' | grep publicName | cut -d'"' -f4 | sort -u > models_new.txt

NEW_COUNT=$(wc -l < models_new.txt)
log "   Found $NEW_COUNT model names"

# Extract detailed model data
log "🔍 Extracting detailed model data..."
extract_model_data "$HTML" > models_detailed_new.json

DETAILED_COUNT=$(wc -l < models_detailed_new.json)
log "   Extracted $DETAILED_COUNT detailed records"

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
    
    log "   Sample models:"
    head -5 "$SIMPLE_LIST" | while read model; do
        log "     • $model"
    done
    log "     ... and $((NEW_COUNT - 5)) more"
    
    # Use ACTUAL line breaks, not %0A
    MSG="🤖 <b>LMArena Tracker Started!</b>

📊 Now tracking <b>$NEW_COUNT models</b>

✅ You'll be notified about:
  • New models added
  • Models removed
  • Model names changed
  • Rankings changed

🔗 https://lmarena.ai"
    
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

# Find additions/removals
ADDED=$(comm -13 "$SIMPLE_LIST" models_new.txt)
REMOVED=$(comm -23 "$SIMPLE_LIST" models_new.txt)

ADDED_COUNT=$(echo "$ADDED" | grep -c . || echo 0)
REMOVED_COUNT=$(echo "$REMOVED" | grep -c . || echo 0)

log ""
log "   Added:    $ADDED_COUNT"
log "   Removed:  $REMOVED_COUNT"

# ============================================
# REPORT NEW MODELS
# ============================================

if [ ! -z "$ADDED" ] && [ "$ADDED_COUNT" -gt 0 ]; then
    log ""
    log "🆕 NEW MODELS DETECTED ($ADDED_COUNT):"
    
    # Build message with ACTUAL line breaks
    MSG="🆕 <b>NEW MODELS ADDED</b>

📊 <b>Count:</b> $ADDED_COUNT

"
    
    COUNTER=0
    echo "$ADDED" | while read model; do
        COUNTER=$((COUNTER + 1))
        log "   [$COUNTER] + $model"
        
        # Get detailed info
        DETAILS=$(grep "\"publicName\":\"$model\"" models_detailed_new.json 2>/dev/null | head -1)
        
        if [ ! -z "$DETAILS" ]; then
            ORG=$(echo "$DETAILS" | grep -o '"organization":"[^"]*"' | cut -d'"' -f4)
            RANK=$(echo "$DETAILS" | grep -o '"rank":[0-9]*' | cut -d':' -f2)
            
            if [ ! -z "$ORG" ] && [ ! -z "$RANK" ]; then
                MSG="${MSG}• <code>$model</code>
  └ Org: <i>$ORG</i> | Rank: #$RANK
"
            else
                MSG="${MSG}• <code>$model</code>
"
            fi
        else
            MSG="${MSG}• <code>$model</code>
"
        fi
        
        # Limit to 20
        if [ "$COUNTER" -ge 20 ]; then
            REMAINING=$((ADDED_COUNT - 20))
            if [ "$REMAINING" -gt 0 ]; then
                MSG="${MSG}
<i>...and $REMAINING more</i>
"
            fi
            break
        fi
    done
    
    MSG="${MSG}
⏰ $(date '+%Y-%m-%d %H:%M UTC')
🔗 https://lmarena.ai"
    
    send_telegram "$MSG"
fi

# ============================================
# REPORT REMOVED MODELS
# ============================================

if [ ! -z "$REMOVED" ] && [ "$REMOVED_COUNT" -gt 0 ]; then
    log ""
    log "❌ MODELS REMOVED ($REMOVED_COUNT):"
    
    MSG="❌ <b>MODELS REMOVED</b>

📊 <b>Count:</b> $REMOVED_COUNT

<i>⚠️ These were likely anonymous/stealth models renamed or removed:</i>

"
    
    COUNTER=0
    echo "$REMOVED" | while read model; do
        COUNTER=$((COUNTER + 1))
        log "   [$COUNTER] - $model"
        
        # Get previous details
        OLD_DETAILS=$(grep "\"publicName\":\"$model\"" "$MODELS_FILE" 2>/dev/null | head -1)
        
        if [ ! -z "$OLD_DETAILS" ]; then
            ORG=$(echo "$OLD_DETAILS" | grep -o '"organization":"[^"]*"' | cut -d'"' -f4)
            RANK=$(echo "$OLD_DETAILS" | grep -o '"rank":[0-9]*' | cut -d':' -f2)
            
            if [ ! -z "$ORG" ] && [ ! -z "$RANK" ]; then
                MSG="${MSG}• <code>$model</code>
  └ Was: <i>$ORG</i> | Rank: #$RANK
"
            else
                MSG="${MSG}• <code>$model</code>
"
            fi
        else
            MSG="${MSG}• <code>$model</code>
"
        fi
        
        # Limit to 20
        if [ "$COUNTER" -ge 20 ]; then
            REMAINING=$((REMOVED_COUNT - 20))
            if [ "$REMAINING" -gt 0 ]; then
                MSG="${MSG}
<i>...and $REMAINING more</i>
"
            fi
            break
        fi
    done
    
    MSG="${MSG}
⏰ $(date '+%Y-%m-%d %H:%M UTC')"
    
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
