/**
 * Hugging Face Lab Registry & Configuration
 * Tracks 28 Tier-1 AI Labs & Frontier Model Creators.
 */

export const LABS = {
  'Qwen': {
    name: 'Qwen (Alibaba)',
    avatar: 'https://cdn-avatars.huggingface.co/v1/production/uploads/6215ca5692c0ecfba9186921/hrRM50-6XcdWgg2AKpENG.jpeg',
    category: 'Frontier AI & Reasoner',
    color: 0x6366F1
  },
  'deepseek-ai': {
    name: 'DeepSeek',
    avatar: 'https://cdn-avatars.huggingface.co/v1/production/uploads/6538815d1bdb3c40db94fbfa/xMBly9PUMphrFVMxLX4kq.png',
    category: 'Frontier AI & Reasoner',
    color: 0x0EA5E9
  },
  'meta-llama': {
    name: 'Meta Llama',
    avatar: 'https://cdn-avatars.huggingface.co/v1/production/uploads/646cf8084eefb026fb8fd8bc/oCTqufkdTkjyGodsx1vo1.png',
    category: 'Open Weights Giant',
    color: 0x1877F2
  },
  'facebook': {
    name: 'Meta AI / FAIR',
    avatar: 'https://cdn-avatars.huggingface.co/v1/production/uploads/1592839207516-noauth.png',
    category: 'Research Lab',
    color: 0x1877F2
  },
  'mistralai': {
    name: 'Mistral AI',
    avatar: 'https://cdn-avatars.huggingface.co/v1/production/uploads/634c17653d11eaedd88b314d/9OgyfKstSZtbmsmuG8MbU.png',
    category: 'Frontier AI',
    color: 0xF97316
  },
  'google': {
    name: 'Google',
    avatar: 'https://cdn-avatars.huggingface.co/v1/production/uploads/5dd96eb166059660ed1ee413/WtA3YYitedOr9n02eHfJe.png',
    category: 'Frontier AI',
    color: 0x4285F4
  },
  'microsoft': {
    name: 'Microsoft',
    avatar: 'https://cdn-avatars.huggingface.co/v1/production/uploads/1583646260758-5e64858c87403103f9f1055d.png',
    category: 'Frontier AI & Small Models',
    color: 0x00A4EF
  },
  'nvidia': {
    name: 'NVIDIA',
    avatar: 'https://cdn-avatars.huggingface.co/v1/production/uploads/65df9200dc3292a8983e5017/Vs5FPVCH-VZBipV3qKTuy.png',
    category: 'Frontier AI & Acceleration',
    color: 0x76B900
  },
  'xai-org': {
    name: 'xAI (Grok)',
    avatar: 'https://cdn-avatars.huggingface.co/v1/production/uploads/65f32e8277a2f0e983437469/fKpP0Yowa29vJHK9JSnBf.png',
    category: 'Frontier AI',
    color: 0x111827
  },
  'openai': {
    name: 'OpenAI',
    avatar: 'https://cdn-avatars.huggingface.co/v1/production/uploads/68783facef79a05727260de3/UPX5RQxiPGA-ZbBmArIKq.png',
    category: 'Frontier AI',
    color: 0x10A37F
  },
  'apple': {
    name: 'Apple',
    avatar: 'https://cdn-avatars.huggingface.co/v1/production/uploads/1653390727490-5dd96eb166059660ed1ee413.jpeg',
    category: 'Frontier AI & Vision',
    color: 0x94A3B8
  },
  'moonshotai': {
    name: 'Moonshot AI (Kimi)',
    avatar: 'https://cdn-avatars.huggingface.co/v1/production/uploads/641c1e77c3983aa9490f8121/X1yT2rsaIbR9cdYGEVu0X.jpeg',
    category: 'Chinese Frontier & Long Context',
    color: 0x3B82F6
  },
  'MiniMaxAI': {
    name: 'MiniMax',
    avatar: 'https://cdn-avatars.huggingface.co/v1/production/uploads/676e38ad04af5bec20bc9faf/dUd-LsZEX0H_d4qefO_g6.jpeg',
    category: 'Multimodal & Video',
    color: 0xEC4899
  },
  'stepfun-ai': {
    name: 'StepFun',
    avatar: 'https://cdn-avatars.huggingface.co/v1/production/uploads/644f7e6233ac8f46fa0b9e26/CmF2ocXhkr2UtHXgmwq7-.png',
    category: 'Chinese Frontier & MoE',
    color: 0x8B5CF6
  },
  'ByteDance': {
    name: 'ByteDance',
    avatar: 'https://cdn-avatars.huggingface.co/v1/production/uploads/6535c9e88bde2fae19b6fb25/0clr54wj5Ly-RkYU9OXPp.png',
    category: 'Frontier & Diffusion',
    color: 0x3B82F6
  },
  'Tencent-Hunyuan': {
    name: 'Tencent Hunyuan',
    avatar: 'https://cdn-avatars.huggingface.co/v1/production/uploads/62d22496c58f969c152bcefd/woKSjt2wXvBNKussyYPsa.png',
    category: 'Video & 3D Frontier',
    color: 0x0052D9
  },
  'TencentARC': {
    name: 'Tencent ARC',
    avatar: 'https://cdn-avatars.huggingface.co/v1/production/uploads/1625552871844-60e272ca6c78a8c122b12127.png',
    category: 'Vision & Image Processing',
    color: 0x0052D9
  },
  'baidu': {
    name: 'Baidu (ERNIE)',
    avatar: 'https://cdn-avatars.huggingface.co/v1/production/uploads/64f187a2cc1c03340ac30498/TYYUxK8xD1AxExFMWqbZD.png',
    category: 'Chinese Frontier',
    color: 0x2932E1
  },
  'LiquidAI': {
    name: 'Liquid AI',
    avatar: 'https://cdn-avatars.huggingface.co/v1/production/uploads/61b8e2ba285851687028d395/EsTgVtnM2IqVRKgPdfqcB.png',
    category: 'Liquid Foundation Models',
    color: 0x06B6D4
  },
  'Xiaomi': {
    name: 'Xiaomi',
    avatar: 'https://raw.githubusercontent.com/walkxcode/dashboard-icons/main/png/xiaomi.png',
    category: 'On-Device AI',
    color: 0xFF6900
  },
  'THUDM': {
    name: 'Zhipu AI / Tsinghua GLM',
    avatar: 'https://cdn-avatars.huggingface.co/v1/production/uploads/63033dc4e1e7f0e03a5e1a31/0BibmRdezvN6v6d2CEtd5.png',
    category: 'Chinese Frontier & Video',
    color: 0x3B82F6
  },
  'zai-org': {
    name: 'Zhipu AI (zai-org)',
    avatar: 'https://cdn-avatars.huggingface.co/v1/production/uploads/62dc173789b4cf157d36ebee/i_pxzM2ZDo3Ub-BEgIkE9.png',
    category: 'Frontier AI',
    color: 0x3B82F6
  },
  'black-forest-labs': {
    name: 'Black Forest Labs (FLUX)',
    avatar: 'https://cdn-avatars.huggingface.co/v1/production/uploads/633f7a8f4be90e06da248e0f/m5YoF33abJ09vcwFxt1Mj.png',
    category: 'Generative Image & Diffusion',
    color: 0x111827
  },
  'Lightricks': {
    name: 'Lightricks (LTX-Video)',
    avatar: 'https://cdn-avatars.huggingface.co/v1/production/uploads/669524bcbcd81f395e8f60f6/0ynfqKEWMh_dn3h4ff1K5.png',
    category: 'Open Video Generation',
    color: 0xA855F7
  },
  'stabilityai': {
    name: 'Stability AI',
    avatar: 'https://cdn-avatars.huggingface.co/v1/production/uploads/643feeb67bc3fbde1385cc25/7vmYr2XwVcPtkLzac_jxQ.png',
    category: 'Generative Media & Audio',
    color: 0x6366F1
  },
  'NousResearch': {
    name: 'Nous Research',
    avatar: 'https://cdn-avatars.huggingface.co/v1/production/uploads/6317aade83d8d2fd903192d9/tPLjYEeP6q1w0j_G2TJG_.png',
    category: 'Reasoning & Post-Training',
    color: 0xEC4899
  },
  'allenai': {
    name: 'Allen Institute for AI (AI2)',
    avatar: 'https://cdn-avatars.huggingface.co/v1/production/uploads/652db071b62cf1f8463221e2/CxxwFiaomTa1MCX_B7-pT.png',
    category: 'Open Frontier & Molmo',
    color: 0x059669
  },
  'CohereLabs': {
    name: 'Cohere',
    avatar: 'https://cdn-avatars.huggingface.co/v1/production/uploads/1678549441248-5e70f6048ce3c604d78fe133.png',
    category: 'Enterprise & Reasoning',
    color: 0x10B981
  }
};

export const TRACKED_ORG_IDS = Object.keys(LABS);

export const HF_API_BASE = 'https://huggingface.co/api';
