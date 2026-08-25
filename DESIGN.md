# Design System

## Direction

Arc-inspired spatial workspace with restrained color, progressive disclosure, and evidence-led trust. Discovery and workflow review share one surface. Skill management uses pinned items plus a quiet list with inline expansion.

## Theme

The primary presentation is dark, with a pure titanium obsidian near-black canvas and high-craft cobalt/azure surfaces. A full light theme mirrors the same hierarchy with studio warm white and slate.

## Color

All production tokens use OKLCH.

### Dark (Titanium Obsidian & Electric Cobalt)

- Background: `oklch(0.120 0.004 250)` (#0d0e11)
- Canvas: `oklch(0.145 0.005 250)` (#121418)
- Surface: `oklch(0.175 0.006 250)` (#181a1f)
- Raised surface: `oklch(0.215 0.008 250)` (#20232a)
- Rail: `oklch(0.160 0.006 250)` (#15171b)
- Ink: `oklch(0.960 0.003 250)` (#f2f4f8)
- Muted: `oklch(0.620 0.010 250)` (#858b98)
- Subtle: `oklch(0.440 0.010 250)` (#555a66)
- Border: `oklch(0.260 0.007 250)` (#2a2e36)
- Primary: `oklch(0.580 0.200 250)` (#2563eb - Electric Cobalt)
- Accent: `oklch(0.780 0.130 210)` (#38bdf8 - Electric Azure)
- Success: `oklch(0.760 0.160 155)` (#10b981 - Crisp Emerald)
- Waiting: `oklch(0.780 0.150 75)` (#f59e0b - Warm Amber)

### Light (Studio Warm White & Slate)

- Background: `oklch(0.985 0.002 250)` (#f8f9fa)
- Canvas: `oklch(1 0 0)` (#ffffff)
- Surface: `oklch(0.965 0.004 250)` (#f1f3f6)
- Raised surface: `oklch(0.925 0.007 250)` (#e4e7ed)
- Rail: `oklch(0.940 0.005 250)` (#edf0f4)
- Ink: `oklch(0.160 0.010 250)` (#111317)
- Muted: `oklch(0.480 0.015 250)` (#5f6472)
- Subtle: `oklch(0.640 0.010 250)` (#8b91a0)
- Border: `oklch(0.890 0.006 250)` (#d8dce4)
- Primary: `oklch(0.520 0.210 250)` (#1d4ed8 - Bold Royal Cobalt)
- Accent: `oklch(0.580 0.160 215)` (#0284c7 - Electric Azure)
- Success: `oklch(0.420 0.140 155)` (#059669 - Deep Emerald)
- Waiting: `oklch(0.460 0.140 75)` (#d97706 - Warm Amber)

## Typography

Use one native product stack: `ui-sans-serif`, `-apple-system`, `BlinkMacSystemFont`, `Segoe UI`, `PingFang SC`, and `Microsoft YaHei`. Five fixed sizes cover caption, metadata, body, subheading, and page title. Use tabular numerals for confidence, time, and repetition counts.

## Components

- Maximum panel radius: 12px.
- Primary buttons use solid electric cobalt with white text.
- Workflow lines use electric azure / cobalt and never carry meaning without labels or icons.
- Depth comes from explicit surface lightness and crisp 1px borders, zero box shadows.
- Focus rings are always visible for keyboard navigation.
