import { useEffect } from 'react'
import { useStore, type AgentEvent } from '../store'

export function useAgentEvents(): void {
  const appendAgentEvent = useStore((state) => state.appendAgentEvent)

  useEffect(() => {
    return window.api.agent.onEvent((event) => {
      appendAgentEvent(event as AgentEvent)
    })
  }, [appendAgentEvent])
}
