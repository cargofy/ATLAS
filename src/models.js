/**
 * ATLAS Data Models — v1.0
 * Industry-standard naming for global logistics use cases.
 *
 * Core models (always available):
 *   Shipment, Carrier, Lane, Rate, Document, TrackingEvent, ServiceLevel
 *
 * Domain extensions (enabled via config.yml models:):
 *   Asset, Driver, TransportOrder  → fleet operators
 *   Facility, Tender, TenderQuote, TenderAward, Dispatch → shippers / procurement
 *   Leg, CustomsEntry              → multimodal operators
 */

/** Core model SQL schema definitions */
export const CORE_SCHEMA = {
  shipments: `
    CREATE TABLE IF NOT EXISTS shipments (
      id TEXT PRIMARY KEY,
      status TEXT,
      mode TEXT,
      origin_country TEXT,
      destination_country TEXT,
      carrier_id TEXT,
      planned_delivery_date TEXT,
      synced_at TEXT,
      data TEXT
    )`,

  carriers: `
    CREATE TABLE IF NOT EXISTS carriers (
      id TEXT PRIMARY KEY,
      name TEXT,
      type TEXT,
      country TEXT,
      rating REAL,
      synced_at TEXT,
      data TEXT
    )`,

  // Lane — industry term for origin-destination-mode pair (replaces "routes")
  lanes: `
    CREATE TABLE IF NOT EXISTS lanes (
      id TEXT PRIMARY KEY,
      origin_country TEXT,
      destination_country TEXT,
      mode TEXT,
      avg_transit_days REAL,
      updated_at TEXT,
      data TEXT
    )`,

  rates: `
    CREATE TABLE IF NOT EXISTS rates (
      id TEXT PRIMARY KEY,
      carrier_id TEXT,
      origin_country TEXT,
      destination_country TEXT,
      mode TEXT,
      valid_from TEXT,
      valid_to TEXT,
      created_at TEXT,
      data TEXT
    )`,

  documents: `
    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      shipment_id TEXT,
      type TEXT,
      created_at TEXT,
      data TEXT
    )`,

  // TrackingEvent — replaces "events" (explicit name, no ambiguity with system events)
  tracking_events: `
    CREATE TABLE IF NOT EXISTS tracking_events (
      id TEXT PRIMARY KEY,
      shipment_id TEXT,
      timestamp TEXT,
      type TEXT,
      is_exception INTEGER DEFAULT 0,
      lat REAL,
      lon REAL,
      location TEXT,
      data TEXT
    )`,

  // ServiceLevel — planned transit times per lane/service type (replaces "delivery_plans")
  service_levels: `
    CREATE TABLE IF NOT EXISTS service_levels (
      id TEXT PRIMARY KEY,
      origin_country TEXT,
      destination_country TEXT,
      mode TEXT,
      service_type TEXT,
      planned_hours INTEGER,
      data TEXT
    )`,
};

/** Domain extension schemas — created only when enabled in config.yml */
export const EXTENSION_SCHEMA = {

  // Fleet management
  assets: `
    CREATE TABLE IF NOT EXISTS assets (
      id TEXT PRIMARY KEY,
      type TEXT,
      plate TEXT,
      capacity_kg REAL,
      trailer_id TEXT,
      status TEXT,
      current_lat REAL,
      current_lon REAL,
      driver_id TEXT,
      synced_at TEXT,
      data TEXT
    )`,

  drivers: `
    CREATE TABLE IF NOT EXISTS drivers (
      id TEXT PRIMARY KEY,
      name TEXT,
      license_number TEXT,
      phone TEXT,
      asset_id TEXT,
      status TEXT,
      data TEXT
    )`,

  transport_orders: `
    CREATE TABLE IF NOT EXISTS transport_orders (
      id TEXT PRIMARY KEY,
      asset_id TEXT,
      driver_id TEXT,
      status TEXT,
      scheduled_date TEXT,
      actual_departure TEXT,
      actual_arrival TEXT,
      tender_id TEXT,
      data TEXT
    )`,

  // Shipper / procurement
  facilities: `
    CREATE TABLE IF NOT EXISTS facilities (
      id TEXT PRIMARY KEY,
      name TEXT,
      type TEXT,
      country TEXT,
      city TEXT,
      address TEXT,
      lat REAL,
      lon REAL,
      data TEXT
    )`,

  tenders: `
    CREATE TABLE IF NOT EXISTS tenders (
      id TEXT PRIMARY KEY,
      type TEXT,
      status TEXT,
      origin_facility_id TEXT,
      destination_facility_id TEXT,
      commodity TEXT,
      mode TEXT,
      required_volume INTEGER,
      frequency TEXT,
      dispatches_per_period INTEGER,
      start_date TEXT,
      end_date TEXT,
      created_at TEXT,
      data TEXT
    )`,

  tender_quotes: `
    CREATE TABLE IF NOT EXISTS tender_quotes (
      id TEXT PRIMARY KEY,
      tender_id TEXT,
      carrier_id TEXT,
      status TEXT,
      price_per_unit REAL,
      currency TEXT,
      submitted_at TEXT,
      data TEXT
    )`,

  tender_awards: `
    CREATE TABLE IF NOT EXISTS tender_awards (
      id TEXT PRIMARY KEY,
      tender_id TEXT,
      carrier_id TEXT,
      allocated_volume INTEGER,
      rate_per_unit REAL,
      currency TEXT,
      awarded_at TEXT,
      data TEXT
    )`,

  // Dispatch = single execution slot against a volume Tender or TransportOrder
  dispatches: `
    CREATE TABLE IF NOT EXISTS dispatches (
      id TEXT PRIMARY KEY,
      tender_id TEXT,
      award_id TEXT,
      transport_order_id TEXT,
      shipment_id TEXT,
      scheduled_date TEXT,
      status TEXT,
      data TEXT
    )`,

  // Multimodal
  legs: `
    CREATE TABLE IF NOT EXISTS legs (
      id TEXT PRIMARY KEY,
      shipment_id TEXT,
      sequence INTEGER,
      mode TEXT,
      carrier_id TEXT,
      origin TEXT,
      destination TEXT,
      status TEXT,
      departed_at TEXT,
      arrived_at TEXT,
      data TEXT
    )`,

  customs_entries: `
    CREATE TABLE IF NOT EXISTS customs_entries (
      id TEXT PRIMARY KEY,
      shipment_id TEXT,
      leg_id TEXT,
      border_point TEXT,
      entry_type TEXT,
      declaration_number TEXT,
      status TEXT,
      submitted_at TEXT,
      cleared_at TEXT,
      data TEXT
    )`,
};

/** All models: display name → table name mapping */
export const MODEL_REGISTRY = {
  // Core
  shipment:       { table: 'shipments',       core: true  },
  carrier:        { table: 'carriers',         core: true  },
  lane:           { table: 'lanes',            core: true  },
  rate:           { table: 'rates',            core: true  },
  document:       { table: 'documents',        core: true  },
  tracking_event: { table: 'tracking_events',  core: true  },
  service_level:  { table: 'service_levels',   core: true  },
  // Extensions
  asset:          { table: 'assets',           core: false },
  driver:         { table: 'drivers',          core: false },
  transport_order:{ table: 'transport_orders', core: false },
  facility:       { table: 'facilities',       core: false },
  tender:         { table: 'tenders',          core: false },
  tender_quote:   { table: 'tender_quotes',    core: false },
  tender_award:   { table: 'tender_awards',    core: false },
  dispatch:       { table: 'dispatches',       core: false },
  leg:            { table: 'legs',             core: false },
  customs_entry:  { table: 'customs_entries',  core: false },
};

/**
 * Required fields for validation per entity type.
 * Used by mapper.js validateMapped().
 */
export const REQUIRED_FIELDS = {
  shipments:        ['id'],
  carriers:         ['id'],
  lanes:            ['id'],
  rates:            ['id'],
  documents:        ['id'],
  tracking_events:  ['id', 'shipment_id', 'timestamp'],
  service_levels:   ['id', 'mode'],
  assets:           ['id'],
  drivers:          ['id'],
  transport_orders: ['id'],
  facilities:       ['id'],
  tenders:          ['id', 'type'],
  tender_quotes:    ['id', 'tender_id', 'carrier_id'],
  tender_awards:    ['id', 'tender_id', 'carrier_id'],
  dispatches:       ['id', 'tender_id'],
  legs:             ['id', 'shipment_id', 'sequence', 'mode'],
  customs_entries:  ['id', 'shipment_id', 'border_point'],
};

/** Backward-compat aliases for old model names */
export const MODEL_ALIASES = {
  routes:           'lanes',
  events:           'tracking_events',
  delivery_plans:   'service_levels',
  vehicles:         'assets',
  trips:            'transport_orders',
  bids:             'tender_quotes',
  customs:          'customs_entries',
  shipment_legs:    'legs',
};

// ─── Party & Relationship models ────────────────────────────────────────────
// Party = any business entity in the supply chain (shipper, 3PL, carrier,
// consignee, notify_party). Promoted to CORE — present in every use case.

export const PARTY_SCHEMA = {
  parties: `
    CREATE TABLE IF NOT EXISTS parties (
      id TEXT PRIMARY KEY,
      name TEXT,
      role TEXT,
      country TEXT,
      city TEXT,
      contact_email TEXT,
      contact_phone TEXT,
      vat_number TEXT,
      data TEXT
    )`,

  // 3PL manages logistics for a client for a defined period
  managed_relationships: `
    CREATE TABLE IF NOT EXISTS managed_relationships (
      id TEXT PRIMARY KEY,
      client_party_id TEXT,
      provider_party_id TEXT,
      scope TEXT,
      start_date TEXT,
      end_date TEXT,
      status TEXT,
      data TEXT
    )`,
};

// Party roles — standard across all transport modes and markets
export const PARTY_ROLES = [
  'shipper',          // cargo owner / sender
  'consignee',        // cargo recipient
  'notify_party',     // bank, customs agent, insurance
  'freight_broker',   // spot broker, earns on margin
  '3pl',              // managed logistics provider
  'carrier',          // actually moves the goods
  'customs_agent',    // handles customs clearance
  'terminal',         // port, rail terminal, cross-dock operator
];

// Tender types
export const TENDER_TYPES = {
  spot:     'One-time shipment quote request',
  volume:   'Recurring/high-volume procurement (grain, construction)',
  contract: 'Annual or multi-month rate agreement',
};

// Tender status flow
export const TENDER_STATUS = [
  'draft', 'open', 'collecting_quotes',
  'awarded', 'partially_awarded', 'active', 'closed', 'cancelled',
];

// ─── Marketplace models — UC-6: Asset-based carrier / load matching ──────────
// Covers: load board integration (DAT, Trans.eu, TimoCom, email, phone),
// asset availability tracking, offer lifecycle management.
// Both sides: carrier searching for loads, shipper posting loads.

export const MARKETPLACE_SCHEMA = {

  // LoadListing = any incoming load opportunity from any source
  // Source can be: dat, trans_eu, timocom, trucknet, email, phone, manual, api
  load_listings: `
    CREATE TABLE IF NOT EXISTS load_listings (
      id TEXT PRIMARY KEY,
      source TEXT,
      external_id TEXT,
      shipper_party_id TEXT,
      origin_country TEXT,
      origin_city TEXT,
      destination_country TEXT,
      destination_city TEXT,
      cargo_type TEXT,
      weight_kg REAL,
      volume_m3 REAL,
      available_from TEXT,
      rate_offered REAL,
      currency TEXT,
      status TEXT,
      expires_at TEXT,
      fetched_at TEXT,
      data TEXT
    )`,

  // AssetAvailability = when/where a truck or trailer will be free
  // Auto-updated when a TransportOrder is completed or created
  asset_availability: `
    CREATE TABLE IF NOT EXISTS asset_availability (
      id TEXT PRIMARY KEY,
      asset_id TEXT,
      available_from TEXT,
      available_until TEXT,
      location_country TEXT,
      location_city TEXT,
      capacity_kg REAL,
      capacity_m3 REAL,
      notes TEXT,
      data TEXT
    )`,

  // FreightOffer = carrier's quoted rate on a specific LoadListing
  // Status flow: draft → submitted → accepted | rejected | expired
  freight_offers: `
    CREATE TABLE IF NOT EXISTS freight_offers (
      id TEXT PRIMARY KEY,
      listing_id TEXT,
      asset_id TEXT,
      driver_id TEXT,
      offered_rate REAL,
      currency TEXT,
      status TEXT,
      submitted_at TEXT,
      valid_until TEXT,
      response_at TEXT,
      data TEXT
    )`,
};

// Load sources — all channels a carrier monitors for loads
export const LOAD_SOURCES = [
  'dat',       // DAT Solutions (US/Canada load board)
  'trans_eu',  // Trans.eu (European freight exchange)
  'timocom',   // TimoCom (European, strong in DACH)
  'trucknet',  // Trucknet (Eastern Europe)
  'cargolist', // Cargolist
  'email',     // IMAP connector — parsed inbound load requests
  'phone',     // Manual entry from phone call
  'whatsapp',  // WhatsApp message (manual or bot-parsed)
  'api',       // Direct API from shipper
  'manual',    // Agent manually entered
];

// LoadListing status flow
export const LISTING_STATUS = [
  'new',      // just fetched, not yet evaluated
  'reviewed', // agent looked at it
  'quoted',   // FreightOffer submitted
  'won',      // offer accepted by shipper
  'lost',     // shipper chose competitor
  'expired',  // load no longer available
  'skipped',  // not relevant (wrong route, weight, etc.)
];

// FreightOffer status flow
export const OFFER_STATUS = ['draft', 'submitted', 'accepted', 'rejected', 'expired', 'withdrawn'];

// ─── Workflow-support models ─────────────────────────────────────────────────
// These models exist to give Cargofy agents enough context to run workflows
// without guessing. ATLAS holds data; Cargofy holds actions.

export const WORKFLOW_SCHEMA = {

  // Review — post-delivery rating between shipper and carrier
  // Bidirectional: shipper rates carrier AND carrier rates shipper
  // Aggregated into Carrier.rating automatically
  reviews: `
    CREATE TABLE IF NOT EXISTS reviews (
      id TEXT PRIMARY KEY,
      shipment_id TEXT,
      reviewer_party_id TEXT,
      reviewed_party_id TEXT,
      rating REAL,
      on_time INTEGER,
      communication INTEGER,
      documentation INTEGER,
      comment TEXT,
      created_at TEXT,
      data TEXT
    )`,

  // MarketSignal — lane-level pricing intelligence
  // Built from Rate history + LoadListing activity per lane
  // Refreshed by connector or computed job
  market_signals: `
    CREATE TABLE IF NOT EXISTS market_signals (
      id TEXT PRIMARY KEY,
      origin_country TEXT,
      destination_country TEXT,
      mode TEXT,
      period TEXT,
      listing_count INTEGER,
      quote_count INTEGER,
      median_rate REAL,
      min_rate REAL,
      max_rate REAL,
      activity_index REAL,
      recommended_rate_low REAL,
      recommended_rate_high REAL,
      computed_at TEXT,
      data TEXT
    )`,

  // Claim — formal exception requiring compensation or investigation
  claims: `
    CREATE TABLE IF NOT EXISTS claims (
      id TEXT PRIMARY KEY,
      shipment_id TEXT,
      type TEXT,
      against_party_id TEXT,
      amount REAL,
      currency TEXT,
      status TEXT,
      filed_at TEXT,
      resolved_at TEXT,
      data TEXT
    )`,
};

// Claim types
export const CLAIM_TYPES = [
  'delay',          // late delivery beyond agreed SLA
  'cargo_damage',   // goods damaged in transit
  'cargo_loss',     // partial or full cargo missing
  'overcharge',     // billed more than agreed rate
  'document_error', // incorrect documentation causing delays
  'other',
];

// Claim status flow
export const CLAIM_STATUS = ['draft', 'filed', 'under_review', 'accepted', 'rejected', 'resolved', 'escalated'];

// Document signature status
export const DOCUMENT_SIGNATURE_STATUS = ['draft', 'sent', 'partially_signed', 'fully_signed', 'rejected', 'expired'];

// ─── Issue model — operational disruption events ─────────────────────────────
// An Issue is a real-time operational disruption that may require replanning.
// Different from Claim (post-factum compensation) — Issues are detected NOW
// and trigger immediate response.
//
// Industry references:
//   DCSA ShipmentEvent exception codes
//   project44 exception type taxonomy
//   IATA delay code taxonomy (adapted for road/multimodal)

export const ISSUE_SCHEMA = {
  issues: `
    CREATE TABLE IF NOT EXISTS issues (
      id TEXT PRIMARY KEY,
      type TEXT,
      severity TEXT DEFAULT 'medium',
      status TEXT DEFAULT 'detected',
      affected_shipment_id TEXT,
      affected_dispatch_id TEXT,
      affected_tender_id TEXT,
      affected_asset_id TEXT,
      requires_replanning INTEGER DEFAULT 0,
      reported_at TEXT DEFAULT (datetime('now')),
      resolved_at TEXT,
      data TEXT
    )`,
};

// Standard logistics disruption types (DCSA + project44 + industry practice)
export const ISSUE_TYPES = {
  // Carrier-side
  carrier_no_show:       'Carrier won tender/dispatch but did not deliver vehicle',
  tender_withdrawal:     'Carrier withdrew from accepted tender or dispatch',
  mechanical_failure:    'Vehicle breakdown en route or at pickup',
  driver_unavailable:    'Driver unavailable: illness, HOS violation, documents expired',
  capacity_shortage:     'Carrier cannot provide required vehicle capacity',

  // Cargo-side
  cargo_not_ready:       'Vehicle arrived but cargo not prepared for loading',
  cargo_damage:          'Cargo damaged at loading, in transit, or at delivery',
  cargo_shortage:        'Partial load — cargo quantity less than expected',
  overweight:            'Cargo exceeds vehicle capacity or legal weight limits',
  hazmat_violation:      'Dangerous goods issue: wrong classification, missing documents',

  // Delay types (IATA-inspired, adapted for all modes)
  delay_traffic:         'Traffic congestion on route',
  delay_weather:         'Weather conditions: snow, flood, storm',
  delay_driver_hours:    'Driver reached legal driving hours limit (tacho)',
  delay_border:          'Border crossing delay: queue, inspection',
  delay_customs:         'Customs clearance delay',
  delay_ramp:            'Loading/unloading ramp unavailable or occupied',
  delay_recipient:       'Consignee unavailable at delivery point',

  // Administrative
  document_error:        'Wrong, missing, or expired transport documents',
  address_error:         'Incorrect pickup or delivery address',
  system_outage:         'TMS, GPS tracker, or critical system unavailable',

  // Force majeure
  force_majeure:         'Natural disaster, strike, road closure, war zone',
  border_closure:        'Border crossing point closed',
};

export const ISSUE_SEVERITY = ['low', 'medium', 'high', 'critical'];

// Status flow: detected → acknowledged → in_resolution → resolved | escalated
export const ISSUE_STATUS = ['detected', 'acknowledged', 'in_resolution', 'resolved', 'escalated', 'cancelled'];

// Issues that always require replanning (others are informational)
export const REPLANNING_TRIGGERS = new Set([
  'carrier_no_show', 'tender_withdrawal', 'mechanical_failure',
  'capacity_shortage', 'cargo_not_ready', 'force_majeure', 'border_closure',
]);
