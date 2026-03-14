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
    
    echo "$html" | python3 << 'PYTHON_SCRIPT'
import sys, json, re

html = sys.stdin.read()

# Find all model objects
# Look for patterns like: {"id":"...","organization":"...","publicName":"...","capabilities":{...},"rank":...}
pattern = r'\{[^{}]*?"publicName"\s*:\s*"([^"]+)"[^{}]*?\}'

models = {}

for match in re.finditer(pattern, html):
    full_block = match.group(0)
    model_name = match.group(1)
    
    # Skip if already processed
    if model_name in models:
        continue
    
    model_data = {
        "publicName": model_name,
        "inputCap": "text",  # default
        "outputCap": "text"  # default
    }
    
    # Extract basic fields
    id_m = re.search(r'"id"\s*:\s*"([^"]+)"', full_block)
    if id_m:
        model_data["id"] = id_m.group(1)
    
    org_m = re.search(r'"organization"\s*:\s*"([^"]+)"', full_block)
    if org_m:
        model_data["organization"] = org_m.group(1)
    
    rank_m = re.search(r'"rank"\s*:\s*(\d+)', full_block)
    if rank_m:
        model_data["rank"] = int(rank_m.group(1))
    
    display_m = re.search(r'"displayName"\s*:\s*"([^"]+)"', full_block)
    if display_m:
        model_data["displayName"] = display_m.group(1)
    
    # Extract capabilities - look for broader context
    # Search in surrounding 1000 chars before and after the model name
    start_idx = html.find('"publicName":"' + model_name + '"')
    if start_idx > 0:
        context = html[max(0, start_idx-1000):start_idx+1000]
        
        input_caps = []
        output_caps = []
        
        # Look for inputCapabilities section
        if 'inputCapabilities' in context:
            input_section = context.split('inputCapabilities')[1].split('}')[0]
            
            if '"text"' in input_section and 'true' in input_section:
                input_caps.append("text")
            if '"image"' in input_section:
                input_caps.append("image")
            if '"audio"' in input_section:
                input_caps.append("audio")
            if '"video"' in input_section:
                input_caps.append("video")
        
        # Look for outputCapabilities section
        if 'outputCapabilities' in context:
            output_section = context.split('outputCapabilities')[1].split('}')[0]
            
            if '"text"' in output_section and 'true' in output_section:
                output_caps.append("text")
            if '"image"' in output_section:
                output_caps.append("image")
            if '"audio"' in output_section:
                output_caps.append("audio")
            if '"video"' in output_section:
                output_caps.append("video")
            if '"web"' in output_section:
                output_caps.append("web")
        
        # Set capabilities
        if input_caps:
            model_data["inputCap"] = ",".join(input_caps)
        if output_caps:
            model_data["outputCap"] = ",".join(output_caps)
    
    models[model_name] = model_data

# Output sorted
for name in sorted(models.keys()):
    print(json.dumps(models[name]))
PYTHON_SCRIPT
}

log "================================================================"
log "🤖 ARENA.AI TRACKER v2.1"
log "================================================================"

# Fetch with retry
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

# First run
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
    
    MSG="🤖 <b>Arena.AI Tracker v2.1 Started!</b>

📊 Now tracking <b>$NEW_COUNT models</b>

✅ Monitoring every 5 minutes:
  • New models with capabilities
  • Anonymous/stealth models
  • Model removals/renames

💬 Silent mode: Only alerts on changes

🔗 https://arena.ai"
    
    send_telegram "$MSG"
    log "✅ Initialization complete"
    exit 0
fi

# Compare
PREV_COUNT=$(wc -l < "$SIMPLE_LIST")
log ""
log "📊 Comparison:"
log "   Previous: $PREV_COUNT | Current: $NEW_COUNT"

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

# Report new models
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
        
        # Get details
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
            
            # Build message with capabilities
            MSG="${MSG}<b>$COUNTER.</b> <code>$model</code>
    📥 In: <i>$INPUT_CAP</i> → 📤 Out: <i>$OUTPUT_CAP</i>
    🏢 Org: <b>$ORG</b> | 🏆 Rank: #$RANK

"
        else
            MSG="${MSG}<b>$COUNTER.</b> <code>$model</code>

"
        fi
        
        # Split if too long
        if [ ${#MSG} -gt 3500 ] && [ $COUNTER -lt $ADDED_COUNT ]; then
            MSG="${MSG}⏰ $(date '+%H:%M UTC') - <i>Continued...</i>"
            send_telegram "$MSG"
            sleep 2
            MSG="🆕 <b>NEW MODELS (Continued)</b>

"
        fi
        
    done <<< "$ADDED"
    
    MSG="${MSG}⏰ $(date '+%Y-%m-%d %H:%M UTC')
🔗 https://arena.ai"
    
    send_telegram "$MSG"
fi

# Report removed
if [ $REMOVED_COUNT -gt 0 ]; then
    log ""
    log "❌ MODELS REMOVED ($REMOVED_COUNT):"
    
    MSG="❌ <b>MODELS REMOVED</b>

📊 <b>Total:</b> $REMOVED_COUNT models

<i>⚠️ Likely stealth/anonymous models renamed:</i>

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
    📥 In: <i>$INPUT_CAP</i> → 📤 Out: <i>$OUTPUT_CAP</i>
    🏢 Was: <b>$ORG</b> | 🏆 Rank: #$RANK

"
        else
            MSG="${MSG}<b>$COUNTER.</b> <code>$model</code>

"
        fi
        
        if [ ${#MSG} -gt 3500 ] && [ $COUNTER -lt $REMOVED_COUNT ]; then
            MSG="${MSG}⏰ $(date '+%H:%M UTC') - <i>Continued...</i>"
            send_telegram "$MSG"
            sleep 2
            MSG="❌ <b>REMOVED (Continued)</b>

"
        fi
        
    done <<< "$REMOVED"
    
    MSG="${MSG}⏰ $(date '+%Y-%m-%d %H:%M UTC')"
    
    send_telegram "$MSG"
fi

# No changes
if [ $ADDED_COUNT -eq 0 ] && [ $REMOVED_COUNT -eq 0 ]; then
    log ""
    log "✅ No changes - silent mode"
fi

# Save
mv models_new.txt "$SIMPLE_LIST"
mv models_detailed_new.json "$MODELS_FILE" 2>/dev/null || true

log ""
log "💾 Saved"
log "================================================================"
log "✅ Complete - Next in 5 min"
log "   Total: $NEW_COUNT | Added: $ADDED_COUNT | Removed: $REMOVED_COUNT"
log "================================================================"
