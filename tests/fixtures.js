// Synthetic DexScreener pairs covering the cases the filters and scorer must
// get right. NOW is fixed so age-dependent rules are deterministic.

export const NOW = 1_760_000_000_000;
const hoursAgo = (h) => NOW - h * 3_600_000;
const minutesAgo = (m) => NOW - m * 60_000;

/** A strong, believable runner: small cap, accelerating, buyers dominant. */
export const goodRunner = {
  chainId: 'solana',
  dexId: 'raydium',
  url: 'https://dexscreener.com/solana/good',
  pairAddress: 'PAIRGOOD',
  baseToken: { address: 'GoodTokenAddress1111111111111111111111111111', name: 'Good Dog', symbol: 'GOODDOG' },
  priceUsd: '0.00042',
  priceChange: { m5: 4, h1: 32, h6: 60, h24: 120 },
  volume: { m5: 30_000, h1: 250_000, h6: 700_000, h24: 1_400_000 },
  txns: {
    m5: { buys: 60, sells: 20 },
    h1: { buys: 700, sells: 300 },
    h6: { buys: 2400, sells: 1600 },
    h24: { buys: 5000, sells: 3000 },
  },
  liquidity: { usd: 180_000 },
  fdv: 900_000,
  marketCap: 900_000,
  pairCreatedAt: hoursAgo(10),
  info: { socials: [{ type: 'twitter' }, { type: 'telegram' }] },
};

/** Same shape, weaker everything — must score below goodRunner. */
export const mediocre = {
  ...goodRunner,
  url: 'https://dexscreener.com/solana/mid',
  baseToken: { address: 'MidTokenAddress22222222222222222222222222222', name: 'Mid Cat', symbol: 'MIDCAT' },
  priceChange: { m5: 0.2, h1: 2, h6: 25, h24: 40 },
  volume: { m5: 2_000, h1: 20_000, h6: 200_000, h24: 900_000 },
  txns: {
    m5: { buys: 12, sells: 12 },
    h1: { buys: 260, sells: 240 },
    h6: { buys: 1000, sells: 1000 },
    h24: { buys: 2600, sells: 2500 },
  },
  liquidity: { usd: 400_000 },
  // Larger than goodRunner's $900K, so it has visibly less headroom, but still
  // inside v4's $3M ceiling — this fixture is meant to be a weak *candidate*,
  // not a rejected one, and at $12M it stopped being scored at all.
  fdv: 2_400_000,
};

export const thinLiquidity = {
  ...goodRunner,
  baseToken: { address: 'ThinTokenAddress3333333333333333333333333333', name: 'Thin', symbol: 'THIN' },
  liquidity: { usd: 4_000 },
};

export const tooNew = {
  ...goodRunner,
  baseToken: { address: 'NewTokenAddress44444444444444444444444444444', name: 'Brand New', symbol: 'NEW' },
  pairCreatedAt: NOW - 10 * 60_000,
};

export const tooBig = {
  ...goodRunner,
  baseToken: { address: 'BigTokenAddress55555555555555555555555555555', name: 'Big Cap', symbol: 'BIG' },
  fdv: 400_000_000,
  marketCap: 400_000_000,
  liquidity: { usd: 900_000 },
};

export const blowOffTop = {
  ...goodRunner,
  baseToken: { address: 'TopTokenAddress66666666666666666666666666666', name: 'Already Ran', symbol: 'LATE' },
  priceChange: { m5: -3, h1: -18, h6: 20, h24: 900 },
};

export const washTrading = {
  ...goodRunner,
  baseToken: { address: 'WashTokenAddress7777777777777777777777777777', name: 'Wash', symbol: 'WASH' },
  volume: { m5: 200, h1: 2_000, h6: 20_000, h24: 60_000 },
  txns: {
    m5: { buys: 200, sells: 200 },
    h1: { buys: 6_000, sells: 6_000 },
    h6: { buys: 20_000, sells: 20_000 },
    h24: { buys: 60_000, sells: 60_000 },
  },
};

export const deadPool = {
  ...goodRunner,
  baseToken: { address: 'DeadTokenAddress8888888888888888888888888888', name: 'Dead', symbol: 'DEAD' },
  volume: { m5: 0, h1: 100, h6: 900, h24: 4_000 },
  txns: {
    m5: { buys: 0, sells: 0 },
    h1: { buys: 3, sells: 4 },
    h6: { buys: 20, sells: 25 },
    h24: { buys: 60, sells: 70 },
  },
};

/** A believable Gamble-tier launch: tiny cap, thin pool, minutes old. */
export const microLaunch = {
  chainId: 'solana',
  dexId: 'raydium',
  url: 'https://dexscreener.com/solana/micro',
  pairAddress: 'PAIRMICRO',
  baseToken: { address: 'MicroTokenAddress999999999999999999999999999', name: 'Micro Frog', symbol: 'MICROFROG' },
  priceUsd: '0.000031',
  priceChange: { m5: 6, h1: 40, h6: 80, h24: 150 },
  volume: { m5: 3_000, h1: 18_000, h6: 45_000, h24: 60_000 },
  txns: {
    m5: { buys: 14, sells: 6 },
    h1: { buys: 90, sells: 40 },
    h6: { buys: 260, sells: 140 },
    h24: { buys: 380, sells: 210 },
  },
  liquidity: { usd: 9_000 },
  fdv: 32_000,
  marketCap: 32_000,
  pairCreatedAt: minutesAgo(25),
  info: { socials: [{ type: 'twitter' }] },
};
