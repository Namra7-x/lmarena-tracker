# Hugging Face Signal Tracker (`hf-tracker`)

An automated, ultra-fast tracker for Hugging Face releases, spaces, collections, and model updates across **28 Tier-1 AI Labs**.

---

## 🏢 Tracked AI Labs (28 Total)

- **Frontier Giants**: Qwen (Alibaba), DeepSeek, Meta (meta-llama, facebook), Mistral AI, Google, Microsoft, NVIDIA, xAI, OpenAI, Apple.
- **Chinese Breakthrough Labs**: Moonshot AI (Kimi), MiniMax, StepFun, ByteDance, Tencent (Hunyuan, ARC), Baidu (ERNIE), Xiaomi, Zhipu AI / GLM (`THUDM`, `zai-org`).
- **Diffusion & Generative Media**: Black Forest Labs (FLUX), Lightricks (LTX-Video), Stability AI.
- **Architectures & Frontier Research**: Liquid AI (LFMs), Allen Institute for AI (`allenai` / Molmo), Cohere (`CohereLabs` / Command-R), Nous Research (Hermes).

---

## 🔍 Monitored Events

1. **`NEW_MODEL` (🚨 Emerald Green)**: Brand new model repository published.
2. **`NEW_SPACE` (🎮 Purple)**: New interactive demo launched (Gradio, Docker, Streamlit).
3. **`NEW_COLLECTION` (📁 Blue)**: New curated collection created by the lab.
4. **`COLLECTION_UPDATED` (✨ Indigo)**: Models or papers added to an existing collection (early indicator of upcoming release suites).
5. **`WEIGHTS_UPDATED` (⚡ Amber)**: Model weights or checkpoints updated within the last 45 days.
6. **`GATING_CHANGED` (🔓 Teal)**: Model unlocked from gated access to public open weights.

---

## 🎨 Discord Rich Embeds

Every notification sent to Discord includes:
- **Author**: Lab Display Name + Official Lab Avatar + Link to Lab Profile.
- **Thumbnail**: High-resolution official logo of the lab.
- **Title**: Event badge + Resource ID (clickable direct link).
- **Inline Fields**: Resource type, pipeline/task tag, access status (gated vs open).
- **Quick Action Links**: `[Model Card]`, `[Files & Weights]`, `[Open Space Demo]`, `[Community Discussions]`.
- **Footer**: Hugging Face logo with timestamp.

---

## ⚙️ Configuration & Discord Webhook Setup

1. In your Discord server, go to **Server Settings > Integrations > Webhooks**.
2. Click **New Webhook**, select your desired channel, and copy the **Webhook URL**.
3. In your GitHub repository:
   - Go to **Settings > Secrets and variables > Actions**.
   - Add a repository secret named **`DISCORD_WEBHOOK_URL`** (or use your existing one).
4. Run the workflow manually via **Actions > Hugging Face Signal Tracker > Run workflow** (optionally toggle `Send test initialization ping`).
