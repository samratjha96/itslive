// Curated word lists for auto-slug generation.
// Rules: no offensive terms, no homophones, max 8 chars, no words that look like numbers.
// Format: {adjective}-{noun}-{00-99}

export const ADJECTIVES = [
  'amber', 'ancient', 'arctic', 'ashen', 'azure', 'bold', 'brave', 'bright',
  'calm', 'clear', 'coastal', 'cool', 'coral', 'crisp', 'crystal', 'cyan',
  'dark', 'dawn', 'deep', 'divine', 'dry', 'dusk', 'dusty', 'eager',
  'early', 'electric', 'epic', 'fair', 'fast', 'firm', 'flint', 'fluid',
  'forest', 'free', 'fresh', 'frosted', 'gentle', 'glacial', 'gold',
  'grand', 'gray', 'green', 'hidden', 'high', 'hollow', 'icy', 'jade',
  'keen', 'kind', 'large', 'late', 'lean', 'light', 'lush', 'marble',
  'mellow', 'mint', 'misty', 'mystic', 'narrow', 'neat', 'noble', 'north',
  'oak', 'open', 'pale', 'pink', 'plain', 'plum', 'polar', 'primal',
  'pure', 'quick', 'quiet', 'rare', 'rapid', 'red', 'rich', 'ripe',
  'rose', 'rough', 'royal', 'ruby', 'rustic', 'sage', 'serene', 'sharp',
  'silent', 'silk', 'silver', 'sky', 'slim', 'slow', 'soft', 'solar',
  'somber', 'south', 'stark', 'steel', 'steep', 'still', 'stone', 'storm',
  'sunny', 'swift', 'teal', 'thin', 'true', 'vast', 'vivid', 'warm',
  'west', 'wild', 'windy', 'wise', 'wooden', 'yellow', 'young', 'zen',
];

export const NOUNS = [
  'arch', 'beam', 'bird', 'bloom', 'bolt', 'bridge', 'brook', 'cave',
  'cliff', 'cloud', 'coast', 'cove', 'crane', 'creek', 'crown', 'dawn',
  'delta', 'dove', 'dune', 'dusk', 'eagle', 'echo', 'ember', 'fern',
  'field', 'fjord', 'flame', 'flare', 'flash', 'flower', 'fog', 'frost',
  'gate', 'gale', 'gem', 'glade', 'glen', 'glow', 'grove', 'harbor',
  'hawk', 'hill', 'hollow', 'horizon', 'island', 'jade', 'lake', 'leaf',
  'lens', 'light', 'lark', 'mist', 'moon', 'moss', 'nest', 'nova',
  'oak', 'opal', 'path', 'peak', 'petal', 'pine', 'plain', 'pond',
  'prism', 'rain', 'ray', 'reef', 'ridge', 'river', 'rock', 'rune',
  'sage', 'sand', 'shore', 'sky', 'slope', 'snow', 'spark', 'star',
  'stem', 'stone', 'storm', 'stream', 'summit', 'tide', 'timber', 'trail',
  'vale', 'vapor', 'vine', 'vista', 'wave', 'wind', 'wood', 'yard',
];

export function generateSlug(): string {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  const num = Math.floor(Math.random() * 100).toString().padStart(2, '0');
  return `${adj}-${noun}-${num}`;
}

// Names permanently unavailable to any user
export const RESERVED_NAMES = new Set([
  'admin', 'api', 'login', 'mail', 'billing', 'www', 'help', 'docs',
  'status', 'dashboard', 'static', 'assets', 'cdn', 'dev', 'test',
  'staging', 'prod', 'support', 'abuse', 'security', 'root', 'system',
  'internal', 'cf', 'cloudflare', 'operator', 'platform', 'auth',
  'signup', 'verify', 'account', 'me', 'app', 'home', 'index',
  'null', 'undefined', 'itslive', 'about', 'contact', 'terms', 'privacy',
]);

export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/;
