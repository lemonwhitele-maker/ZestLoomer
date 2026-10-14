/// <reference types="vite/client" />

import type { LoomAPI } from '../../shared/documents'
declare global {
  interface Window {
    loom: LoomAPI
  }
}
