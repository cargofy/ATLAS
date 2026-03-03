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
