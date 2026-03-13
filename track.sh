#!/bin/bash

# Configuration
BOT_TOKEN="$TELEGRAM_BOT_TOKEN"
CHAT_ID="$TELEGRAM_CHAT_ID"
MODELS_FILE="models_data.json"
SIMPLE_LIST="models_list.txt"
MAX_MSG_LENGTH=4000

send_telegram() {
    local msg="$1"
    local msg_length=${#msg}
    
    if [ $msg_length -le $MAX_MSG_LENGTH ]; then
        curl -s -X POST "https://api.telegram.org/bot$BOT_TOKEN/sendMessage" \
            -d "chat_id=$CHAT_ID" \
            -d "parse_mode=HTML" \
            -d "disable_web_page_preview=true" \
            --data-urlencode "text=$msg" \
            > /dev/null
    else
        # Split message
        local part1="${msg:0:$MAX_MSG_LENGTH}"
        local part2="${msg:$MAX_MSG_LENGTH}"
        
        curl -s -X POST "https://api.telegram.org/bot$BOT_TOKEN/sendMessage" \
            -d "chat_id=$CHAT_ID" \
            -d "parse_mode=HTML" \
            -d "disable_web_page_preview=true" \
            --data-urlencode "text=$part1" \
            > /dev/null
        
        sleep 2
        
        curl -s -X POST "https://api.telegram.org/bot$BOT_TOKEN/sendMessage" \
            -d "chat_id=$CHAT_ID" \
            -d "parse_mode=HTML" \
            -d "disable_web_page_preview=true" \
            --data-urlencode "text=$part2" \
            > /dev/null
    fi
}

log() {
    echo "[$(date '+%Y-%m-%d %H:%M:%S UTC')] $1"
}

extract_model_data() {
    local html="$1"
    
    echo "$html" | python3 -c '
import sys, json, re

html = sys.stdin.read()

pattern = r"\{[^}]*?\"publicName\"\s*:\s*\"([^\"]+)\"[^}]*?\}"
matches = re.finditer(pattern, html)

models = {}

for match in matches:
    full_text = match.group(0)
    model_name = match.group(1)
    
    if model_name in models:
        continue
    
    model_data = {"publicName": model_name}
    
    fields = {
        "id": r"\"id\"\s*:\s*\"([^\"]+)\"",
        "organization": r"\"organization\"\s*:\s*\"([^\"]+)\"",
        "provider": r"\"provider\"\s*:\s*\"([^\"]+)\"",
        "displayName": r"\"displayName\"\s*:\s*\"([^\"]+)\"",
        "rank": r"\"rank\"\s*:\s*([0-9]+)",
    }
    
    for field, regex in fields.items():
        match_field = re.search(regex, full_text)
        if match_field:
            value = match_field.group(1)
            if field == "rank":
                value = int(value)
            model_data[field] = value
    
    # Extract capabilities
    cap_match = re.search(r"\"capabilities\"\s*:\s*\{([^}]+)\}", full_text)
    input_cap = []
    output_cap = []
    
    if cap_match:
        cap_text = cap_match.group(1)
        
        # Input capabilities
        if "\"text\"" in cap_text and "inputCapabilities" in full_text[:full_text.find(cap_text)+len(cap_text)]:
            input_cap.append("text")
        if "\"image\"" in cap_text:
            if "inputCapabilities" in full_text.split("\"image\"")[0][-200:]:
                input_cap.append("image")
        if "\"audio\"" in cap_text:
            if "inputCapabilities" in full_text.split("\"audio\"")[0][-200:]:
                input_cap.append("audio")
        
        # Output capabilities
        if "outputCapabilities" in cap_text:
            output_section = cap_text.split("outputCapabilities")[1] if "outputCapabilities" in cap_text else cap_text
            if "\"text\"" in output_section:
                output_cap.append("text")
            if "\"image\"" in output_section:
                output_cap.append("image")
            if "\"audio\"" in output_section:
                output_cap.append("audio")
            if "\"web\"" in output_section:
                output_cap.append("web")
    
    if not input_cap:
        input_cap = ["text"]
    if not output_cap:
        output_cap = ["text"]
    
    model_data["inputCap"] = ",".join(input_cap)
    model_data["outputCap"] = ",".join(output_cap)
    
    models[model_name] = model_data

for name in sorted(models.keys()):
    print(json.dumps(models[name]))
' 2>/dev/null
}

log "================================================================"
log "🤖 ARENA.AI TRACKER v2.0"
log "================================================================"

# Fetch page with retry
log "📥 Fetching arena.ai..."
RETRY_COUNT=0
MAX_RETRIES=3

while [ $RETRY_COUNT -lt $MAX_RETRIES ]; do
    HTML=$(curl -s -L https://arena.ai \
        -H 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' \
        -H 'Accept: text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' \
        --connect-timeout 30 \
        --max-time 60)
    
    if [ ! -z "$HTML" ] && [ ${#HTML} -gt 1000 ]; then
        break
    fi
    
    RETRY_COUNT=$((RETRY_COUNT + 1))
    log "⚠️  Retry $RETRY_COUNT/$MAX_RETRIES..."
    sleep 5
done

if [ -z "$HTML" ] || [ ${#HTML} -lt 1000 ]; then
    log "❌ Failed to fetch after $MAX_RETRIES retries"
    exit 0
fi

log "✅ Page fetched ($(echo "$HTML" | wc -c) bytes)"

# Extract model names
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
    log "📝 FIRST RUN - Initializing"
    
    cp models_new.txt "$SIMPLE_LIST"
    cp models_detailed_new.json "$MODELS_FILE" 2>/dev/null || touch "$MODELS_FILE"
    
    log "   Sample models:"
    head -5 "$SIMPLE_LIST" | while read model; do
        log "     • $model"
    done
    log "     ... and $((NEW_COUNT - 5)) more"
    
    MSG="🤖 <b>Arena.AI Tracker v2.0 Started!</b>

📊 Now tracking <b>$NEW_COUNT models</b>

✅ Active monitoring:
  • Checks every 5 minutes
  • Detects new models instantly
  • Tracks anonymous/stealth models
  • Shows input/output capabilities

💬 You'll only get notifications when:
  ✓ New models are added
  ✓ Models are removed/renamed

🔗 https://arena.ai"
    
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
log "   Previous: $PREV_COUNT | Current: $NEW_COUNT | Change: $((NEW_COUNT - PREV_COUNT))"

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

log "   Added: $ADDED_COUNT | Removed: $REMOVED_COUNT"

# ============================================
# REPORT NEW MODELS (ALL)
# ============================================

if [ $ADDED_COUNT -gt 0 ]; then
    log ""
    log "🆕 NEW MODELS DETECTED ($ADDED_COUNT):"
    
    MSG="🆕 <b>NEW MODELS ADDED</b>

📊 <b>Total:</b> $ADDED_COUNT new models

"
    
    COUNTER=0
    while IFS= read -r model; do
        [ -z "$model" ] && continue
        
        COUNTER=$((COUNTER + 1))
        log "   [$COUNTER] + $model"
        
        DETAILS=$(grep "\"publicName\":\"$model\"" models_detailed_new.json 2>/dev/null | head -1)
        
        if [ ! -z "$DETAILS" ]; then
            ORG=$(echo "$DETAILS" | grep -o '"organization":"[^"]*"' | cut -d'"' -f4)
            RANK=$(echo "$DETAILS" | grep -o '"rank":[0-9]*' | cut -d':' -f2)
            INPUT_CAP=$(echo "$DETAILS" | grep -o '"inputCap":"[^"]*"' | cut -d'"' -f4)
            OUTPUT_CAP=$(echo "$DETAILS" | grep -o '"outputCap":"[^"]*"' | cut -d'"' -f4)
            
            [ -z "$ORG" ] && ORG="unknown"
            [ -z "$RANK" ] && RANK="?"
            [ -z "$INPUT_CAP" ] && INPUT_CAP="text"
            [ -z "$OUTPUT_CAP" ] && OUTPUT_CAP="text"
            
            MSG="${MSG}<b>$COUNTER.</b> <code>$model</code>
    (In: $INPUT_CAP → Out: $OUTPUT_CAP)
    Org: <i>$ORG</i> | Rank: #$RANK

"
        else
            MSG="${MSG}<b>$COUNTER.</b> <code>$model</code>

"
        fi
        
        # Split if too long
        if [ ${#MSG} -gt 3500 ] && [ $COUNTER -lt $ADDED_COUNT ]; then
            MSG="${MSG}⏰ $(date '+%H:%M UTC')
<i>Continued...</i>"
            send_telegram "$MSG"
            sleep 2
            MSG="🆕 <b>NEW MODELS (Part 2)</b>

"
        fi
        
    done <<< "$ADDED"
    
    MSG="${MSG}⏰ $(date '+%Y-%m-%d %H:%M UTC')
🔗 https://arena.ai"
    
    send_telegram "$MSG"
fi

# ============================================
# REPORT REMOVED MODELS (ALL)
# ============================================

if [ $REMOVED_COUNT -gt 0 ]; then
    log ""
    log "❌ MODELS REMOVED ($REMOVED_COUNT):"
    
    MSG="❌ <b>MODELS REMOVED</b>

📊 <b>Total:</b> $REMOVED_COUNT models removed

<i>⚠️ Likely anonymous/stealth models renamed or removed:</i>

"
    
    COUNTER=0
    while IFS= read -r model; do
        [ -z "$model" ] && continue
        
        COUNTER=$((COUNTER + 1))
        log "   [$COUNTER] - $model"
        
        OLD_DETAILS=$(grep "\"publicName\":\"$model\"" "$MODELS_FILE" 2>/dev/null | head -1)
        
        if [ ! -z "$OLD_DETAILS" ]; then
            ORG=$(echo "$OLD_DETAILS" | grep -o '"organization":"[^"]*"' | cut -d'"' -f4)
            RANK=$(echo "$OLD_DETAILS" | grep -o '"rank":[0-9]*' | cut -d':' -f2)
            INPUT_CAP=$(echo "$OLD_DETAILS" | grep -o '"inputCap":"[^"]*"' | cut -d'"' -f4)
            OUTPUT_CAP=$(echo "$OLD_DETAILS" | grep -o '"outputCap":"[^"]*"' | cut -d'"' -f4)
            
            [ -z "$ORG" ] && ORG="unknown"
            [ -z "$RANK" ] && RANK="?"
            [ -z "$INPUT_CAP" ] && INPUT_CAP="text"
            [ -z "$OUTPUT_CAP" ] && OUTPUT_CAP="text"
            
            MSG="${MSG}<b>$COUNTER.</b> <code>$model</code>
    (In: $INPUT_CAP → Out: $OUTPUT_CAP)
    Was: <i>$ORG</i> | Rank: #$RANK

"
        else
            MSG="${MSG}<b>$COUNTER.</b> <code>$model</code>

"
        fi
        
        # Split if too long
        if [ ${#MSG} -gt 3500 ] && [ $COUNTER -lt $REMOVED_COUNT ]; then
            MSG="${MSG}⏰ $(date '+%H:%M UTC')
<i>Continued...</i>"
            send_telegram "$MSG"
            sleep 2
            MSG="❌ <b>REMOVED (Part 2)</b>

"
        fi
        
    done <<< "$REMOVED"
    
    MSG="${MSG}⏰ $(date '+%Y-%m-%d %H:%M UTC')"
    
    send_telegram "$MSG"
fi

# ============================================
# NO CHANGES - SILENT
# ============================================

if [ $ADDED_COUNT -eq 0 ] && [ $REMOVED_COUNT -eq 0 ]; then
    log ""
    log "✅ No changes - tracker running normally (silent)"
fi

# ============================================
# SAVE STATE
# ============================================

mv models_new.txt "$SIMPLE_LIST"
mv models_detailed_new.json "$MODELS_FILE" 2>/dev/null || true

log ""
log "💾 State saved"
log "================================================================"
log "✅ Complete - Next check in 5 minutes"
log "   Total: $NEW_COUNT | Added: $ADDED_COUNT | Removed: $REMOVED_COUNT"
log "================================================================"
