/**
 * ATLAS Model Registry — manages multiple LLM clients with role-based routing.
 * Supports both new multi-model config and legacy single-model config.
 */

import { LlmClient } from './llm-client.js';

export class ModelRegistry {
  #models = new Map();
  #roles = { default: null, chat: null, extract: null };

  /**
   * Build a registry from the ai: config block.
   * Handles both new multi-model format and legacy flat format.
   */
  static fromConfig(aiConfig = {}) {
    const registry = new ModelRegistry();

    if (Array.isArray(aiConfig.models)) {
      // New multi-model format
      for (const entry of aiConfig.models) {
        const client = new LlmClient(entry);
        registry.#models.set(entry.id, client);
      }
      // Role routing
      for (const role of ['default', 'chat', 'extract']) {
        const id = aiConfig[role];
        if (id && registry.#models.has(id)) {
          registry.#roles[role] = id;
        }
      }
      // Ensure default is set
      if (!registry.#roles.default && registry.#models.size) {
        registry.#roles.default = registry.#models.keys().next().value;
      }
    } else if (aiConfig.provider || aiConfig.api_key || aiConfig.model) {
      // Legacy flat format — treat as single model named "default"
      const client = new LlmClient(aiConfig);
      registry.#models.set('default', client);
      registry.#roles.default = 'default';
      registry.#roles.chat = 'default';
      registry.#roles.extract = 'default';
    }

    return registry;
  }

  /** Get an LlmClient by model ID. */
  get(id) {
    return this.#models.get(id) ?? null;
  }

  /** Get the LlmClient assigned to a role ('chat' | 'extract' | 'default'). */
  getFor(role) {
    const id = this.#roles[role] ?? this.#roles.default;
    return id ? this.#models.get(id) ?? null : null;
  }

  /** List all configured models with metadata. */
  list() {
    const result = [];
    for (const [id, client] of this.#models) {
      result.push({
        id,
        provider: client.provider,
        model: client.model,
        configured: client.isConfigured(),
        roles: Object.entries(this.#roles)
          .filter(([, v]) => v === id)
          .map(([k]) => k),
      });
    }
    return result;
  }
}
