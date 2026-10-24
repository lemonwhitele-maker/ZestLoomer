/// <reference types="vite/client" />

import type { ZestLoomerAPI } from '../../shared/documents'
declare global {
  interface Window {
    zestloomer: ZestLoomerAPI
  }
}
