# Design Brief: ICP NFT Wallet & Marketplace

## Aesthetic & Tone
High-tech cyberpunk terminal aesthetic. Neon green on deep dark backgrounds — feels like a hacker's dashboard or a cutting-edge crypto protocol UI. Electric, authoritative, and precise. Think Bloomberg terminal meets DeFi. Green signifies growth, security, and machine intelligence.

## Color Palette

| Token | Light L | Light C | Light H | Dark L | Dark C | Dark H | Purpose |
|-------|---------|---------|---------|--------|--------|--------|---------|
| Primary | 0.52 | 0.18 | 145 | 0.72 | 0.24 | 142 | Vibrant green, CTA, primary buttons |
| Secondary | 0.60 | 0.14 | 160 | 0.30 | 0.08 | 155 | Teal-green, secondary UI |
| Accent | 0.65 | 0.28 | 142 | 0.80 | 0.32 | 142 | Neon electric green, NFT highlights, price badges |
| Background | 0.95 | — | — | 0.06 | 0.01 | 145 | Light neutral / deep near-black with green tint |
| Card | 0.97 | — | — | 0.10 | 0.02 | 145 | Elevated surfaces, NFT display |
| Success | — | 0.22 | 120 | — | 0.22 | 120 | Transaction complete |

## Typography
**Display**: Bricolage Grotesque (geometric, modern, tech-native). **Body**: DM Sans (clean, legible, trusted). **Mono**: Geist Mono (crypto code, balances, transaction hashes).

## Structural Zones
- **Header/Nav**: `bg-card` with `border-b border-border`. Sticky, contains logo, auth state, admin button.
- **Main Content**: `bg-background`. Grid-based NFT wallet, marketplace sections.
- **NFT Card**: `bg-card` with `nft-card-glow` shadow. Subtle 1px border, accent overlay on hover.
- **Marketplace Section**: Alt `bg-muted/15` with clear price typography in accent color, bid indicators.
- **Footer**: `bg-muted/20` with `border-t border-border`.

## Elevation & Depth
Cards use `nft-card-glow` (inset highlight + outer glow at accent color). Hover triggers `nft-card-glow-hover` for intensity. No deep shadows — focus is on border + light effects.

## Spacing & Rhythm
Desktop: 8px grid (16px, 24px, 32px). Card padding: 16px. Gap between cards: 20px. Marketplace price labels: 12px mono, bold, accent color.

## Component Patterns
- **NFT Card**: image + metadata + `price-badge`. Hover: glow intensifies, metadata fades slightly.
- **Price Badge**: Rounded pill, accent background, white text, mono font.
- **Bid Indicator**: `bid-typography` (accent, mono, bold) for active bids.
- **Marketplace Grid**: 3–4 columns (responsive), clear price positioning.

## Motion
Smooth default: `transition-smooth` (0.3s ease-in-out). Entrance: fade-in + scale-up. Hover: glow intensify, no bounce.

## Constraints
- No rainbow palettes or color chaos. Neon green accent + primary green only.
- Cards never float or have deep shadows — depth is via color + glows only.
- Price typography always in accent color, never muted.
- Do not exceed 3 font sizes across the app (display, body, small).
- Dark mode: backgrounds must retain green tint (H145) — never pure neutral black.

## Signature Detail
NFT cards with neon electric green glow on hover — like a terminal cursor or a live data feed lighting up. In dark mode, the deep green-tinted backgrounds + bright neon accent create a cyberpunk hacker aesthetic. Accent color commands attention on prices and bid indicators; every price looks like a live market feed.
