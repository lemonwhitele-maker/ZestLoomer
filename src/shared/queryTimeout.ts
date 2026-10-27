// Only read operations may time out locally. Write replies remain authoritative.
export const timedQueries = new Set([
  'list',
  'read',
  'workspace:stats',
  'workspace:history',
  'workspace:history-read',
  'workspace:preferences:get',
  'story:bindings',
  'story:read',
  'story:foreshadows',
  'agent:snapshot',
  'agent:config',
  'tools:config'
])
export function queryTimeout<T>(request: Promise<T>, milliseconds = 30000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          Object.assign(new Error('读取等待超时。后台读取可能仍在进行，请稍后手动重试。'), {
            code: 'QUERY_TIMEOUT'
          })
        ),
      milliseconds
    )
    request.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}
