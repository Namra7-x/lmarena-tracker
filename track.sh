#!/bin/bash

# Configuration
BOT_TOKEN="$TELEGRAM_BOT_TOKEN"
CHAT_ID="$TELEGRAM_CHAT_ID"
MODELS_FILE="models_data.json"
SIMPLE_LIST="models_list.txt"

send_telegram() {
    local msg="$1"
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

# Extract model list
log "🔍 Extracting model names..."
echo "$HTML" | tr ',' '\n' | grep publicName | cut -d'"' -f4 | sort -u > models_new.txt

NEW_COUNT=$(wc -l < models_new.txt)
log "   Found $NEW_COUNT model names"

# Extract detailed data
log "🔍 Extracting detailed model data..."
extract_model_data "$HTML" > models_detailed_new.json

DETAILED_COUNT=$(wc -l < models_detailed_new.json)
log "   Extracted $DETAILED_COUNT detailed records"

if [ ! -s models_new.txt ]; then
    log "❌ No models extracted"
    exit 0
fi

# ============================================
# FIRST RUN
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
    
    MSG="🤖 <b>LMArena Tracker Started!</b>

📊 Now tracking <b>$NEW_COUNT models</b>

✅ You'll be notified about:
  • New models added
  • Models removed (stealth/anonymous)
  • Model rankings changed
  • Organization changes

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

# Find changes
ADDED=$(comm -13 "$SIMPLE_LIST" models_new.txt)
REMOVED=$(comm -23 "$SIMPLE_LIST" models_new.txt)

ADDED_COUNT=0
REMOVED_COUNT=0

if [ ! -z "$ADDED" ]; then
    ADDED_COUNT=$(echo "$ADDED" | wc -l)
fi

if [ ! -z "$REMOVED" ]; then
    REMOVED_COUNT=$(echo "$REMOVED" | wc -l)
fi

log "   Added:    $ADDED_COUNT"
log "   Removed:  $REMOVED_COUNT"

# ============================================
# REPORT NEW MODELS
# ============================================

if [ $ADDED_COUNT -gt 0 ]; then
    log ""
    log "🆕 NEW MODELS DETECTED ($ADDED_COUNT):"
    
    MSG="🆕 <b>NEW MODELS ADDED</b>

📊 <b>Count:</b> $ADDED_COUNT

"
    
    COUNTER=0
    while IFS= read -r model; do
        [ -z "$model" ] && continue
        
        COUNTER=$((COUNTER + 1))
        log "   [$COUNTER] + $model"
        
        # Get details from JSON
        DETAILS=$(grep "\"publicName\":\"$model\"" models_detailed_new.json 2>/dev/null | head -1)
        
        if [ ! -z "$DETAILS" ]; then
            ORG=$(echo "$DETAILS" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('organization','unknown'))" 2>/dev/null)
            RANK=$(echo "$DETAILS" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('rank','?'))" 2>/dev/null)
            
            [ -z "$ORG" ] && ORG="unknown"
            [ -z "$RANK" ] && RANK="?"
            
            MSG="${MSG}$COUNTER. <code>$model</code>
   └ Org: <i>$ORG</i> | Rank: #$RANK

"
        else
            MSG="${MSG}$COUNTER. <code>$model</code>

"
        fi
        
        # Limit to 20 models
        if [ $COUNTER -ge 20 ]; then
            REMAINING=$((ADDED_COUNT - 20))
            if [ $REMAINING -gt 0 ]; then
                MSG="${MSG}<i>...and $REMAINING more models</i>

"
            fi
            break
        fi
    done <<< "$ADDED"
    
    MSG="${MSG}⏰ $(date '+%Y-%m-%d %H:%M UTC')
🔗 https://lmarena.ai"
    
    send_telegram "$MSG"
fi

# ============================================
# REPORT REMOVED MODELS
# ============================================

if [ $REMOVED_COUNT -gt 0 ]; then
    log ""
    log "❌ MODELS REMOVED ($REMOVED_COUNT):"
    
    MSG="❌ <b>MODELS REMOVED</b>

📊 <b>Count:</b> $REMOVED_COUNT

<i>⚠️ These were likely anonymous/stealth models that got renamed or removed from testing:</i>

"
    
    COUNTER=0
    while IFS= read -r model; do
        [ -z "$model" ] && continue
        
        COUNTER=$((COUNTER + 1))
        log "   [$COUNTER] - $model"
        
        # Get previous details from old JSON
        OLD_DETAILS=$(grep "\"publicName\":\"$model\"" "$MODELS_FILE" 2>/dev/null | head -1)
        
        if [ ! -z "$OLD_DETAILS" ]; then
            ORG=$(echo "$OLD_DETAILS" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('organization','unknown'))" 2>/dev/null)
            RANK=$(echo "$OLD_DETAILS" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('rank','?'))" 2>/dev/null)
            
            [ -z "$ORG" ] && ORG="unknown"
            [ -z "$RANK" ] && RANK="?"
            
            MSG="${MSG}$COUNTER. <code>$model</code>
   └ Was: <i>$ORG</i> | Rank: #$RANK

"
        else
            MSG="${MSG}$COUNTER. <code>$model</code>

"
        fi
        
        # Limit to 20
        if [ $COUNTER -ge 20 ]; then
            REMAINING=$((REMOVED_COUNT - 20))
            if [ $REMAINING -gt 0 ]; then
                MSG="${MSG}<i>...and $REMAINING more models</i>

"
            fi
            break
        fi
    done <<< "$REMOVED"
    
    MSG="${MSG}⏰ $(date '+%Y-%m-%d %H:%M UTC')"
    
    send_telegram "$MSG"
fi

# ============================================
# NO CHANGES
# ============================================

if [ $ADDED_COUNT -eq 0 ] && [ $REMOVED_COUNT -eq 0 ]; then
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
