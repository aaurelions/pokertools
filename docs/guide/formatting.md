# Docs & Text Formatting

These docs are built with [VitePress 2.0.0-alpha.20](https://vitepress.dev) and extended with
custom markdown-it plugins. This page is the living reference for every formatting
feature you can use in these pages.

## Headings, lists, links

Everything from CommonMark plus VitePress extras:

- Ordered and unordered lists, nesting, task lists:

  - [x] Write docs
  - [ ] Release

- [Internal links](/packages/overview), [external links](https://github.com/aaurelions/pokertools) (open in a new tab)
- Footnotes[^1]

[^1]: Footnote text rendered at the bottom of the page.

## Tables

Tables are the workhorse of these docs — pipe tables with alignment:

| Hand rank      | Beats          | Frequency (7 cards) |
| :------------- | :------------- | :------------------ |
| Royal flush    | Everything     | 4 324               |
| Straight flush | Four of a kind | 37 260              |
| Four of a kind | Full house     | 224 848             |
| Full house     | Flush          | 3 473 184           |
| Flush          | Straight       | 4 047 644           |

## Inline text formatter

The custom markdown plugins add rich inline formatting:

| Markup       | Renders as            | Use it for               |
| :----------- | :-------------------- | :----------------------- |
| `==text==`   | ==highlighted== (max) | Emphasizing a key term   |
| `^^text^^`   | ^^underlined^^        | Deprecation notes, terms |
| `**bold**`   | **bold**              | Strong emphasis          |
| `*italic*`   | _italic_              | Emphasis                 |
| `` `code` `` | `inline code`         | API names, identifiers   |
| `~~strike~~` | ~~strike~~            | Removed content          |

Example sentence: the engine's `gameReducer` is a ==pure function== — call it with the same
state and action and you ^^always^^ get the same next state, which makes undo, replay and
testing trivial.

## Callout containers

::: info
Non-critical context — e.g. where a feature applies.
:::

::: tip
Best practice that saves you from a common mistake.
:::

::: warning
Something that can surprise you, like a behavioral rule change.
:::

::: danger
Security-relevant guidance. Read before deploying.
:::

::: details Click to expand
A more detailed explanation.
:::

### Custom container titles

::: info Why ante pots exist
Antes are collected as dead money and never count toward the live preflop wager, so the
minimum raise stays `big blind × 2` even with antes in play.
:::

## Code groups (tabs)

::: code-group

```ts [npm]
npm install @pokertools/engine
```

```ts [pnpm]
pnpm add @pokertools/engine
```

```ts [yarn]
yarn add @pokertools/engine
```

:::

## Code blocks

```ts
// TypeScript with syntax highlighting
import { PokerEngine } from "@pokertools/engine";

const engine = new PokerEngine({ smallBlind: 5, bigBlind: 10 });
console.log(engine.state.currentBets);
```

```solidity
// Solidity highlighting for contract snippets
contract BatchSweeper is Ownable {
    function batchSweep(...) external onlyOwner {}
}
```

::: tip
Every code block has a copy button; language labels auto-detect or come from the language tag.
:::

## Math (markdown-it-mathjax3)

Inline math: pot odds $\frac{20}{20 + 60} = 25\%$

Block math:

$$
EV = \sum_{i} P_i \times V_i
$$

## Layout niceties

- **Line highlighting** in code blocks via `// [!code highlight]`
- **Focus** via `// [!code focus]`
- **Diff** via `// [!code ++]` / `// [!code --]`
- Emoji: 🃏 ⚡ 📚 🔌

## Writing style

| Do                                          | Don't                                       |
| :------------------------------------------ | :------------------------------------------ |
| Use tables for API references and options   | Write long prose lists                      |
| Show runnable examples for every public API | Reference APIs without examples             |
| Use `==` highlights sparingly               | Highlight entire paragraphs                 |
| Link between package pages                  | Duplicate content across pages              |
| Keep examples copy-pasteable                | Use fictional IDs without a generation step |
