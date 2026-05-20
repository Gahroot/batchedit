import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useStore } from '../store'

export function AgentReviewModal() {
  const prompt = useStore((state) => state.agentReviewPrompt)
  const respondToReview = useStore((state) => state.respondToReview)
  const setAgentReviewPrompt = useStore((state) => state.setAgentReviewPrompt)

  return (
    <Dialog open={prompt !== null} onOpenChange={(open) => !open && setAgentReviewPrompt(null)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Agent Review Required</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <p className="text-sm text-muted-foreground">{prompt?.reason}</p>
          {prompt?.attach ? (
            <pre className="max-h-48 overflow-auto rounded-md bg-muted p-3 text-xs">
              {JSON.stringify(prompt.attach, null, 2)}
            </pre>
          ) : null}
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => respondToReview({ approved: false })}>
              Reject
            </Button>
            <Button onClick={() => respondToReview({ approved: true })}>Approve</Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
