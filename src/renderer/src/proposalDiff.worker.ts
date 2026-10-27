import { proposalPreview } from './proposalPreview'
self.onmessage = (event: MessageEvent<{ before: string; after: string; unified: boolean }>) => {
  const { before, after, unified } = event.data
  self.postMessage(proposalPreview(before, after, unified))
}
