type ClientInitializer = () => void | (() => void)
const initializers = new Set<ClientInitializer>()

export function registerClientInitializer(initializer: ClientInitializer): () => void {
  initializers.add(initializer)
  return () => { initializers.delete(initializer) }
}

export function startClientLifecycle(): () => void {
  const cleanups = [...initializers].map(initializer => initializer())
  return () => { for (const cleanup of cleanups.reverse()) cleanup?.() }
}
