---
id: TND-XXX
title: "Q2 2026 — PL to DE Spot Load"
type: spot
status: open
shipper_id: PARTY-XXX
managed_by_party_id: PARTY-3PL
origin_country: PL
destination_country: DE
cargo_type: general
weight_kg: 24000
volume_m3: 86
pickup_date: "2026-03-15T07:00:00Z"
deadline: "2026-03-14T18:00:00Z"
notes: "Tail lift required. No ADR."
---

# Tender Notes

**Type values:** `spot` · `volume` · `dedicated` · `framework`

**Status flow:** `draft` → `open` → `partially_awarded` → `fully_awarded` → `active` → `closed`

For **volume tenders**, add:
```yaml
required_volume: 40     # trucks per period
frequency: weekly       # daily | weekly | monthly
```
