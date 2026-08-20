"use client"

import { MessageSquareText, ShieldCheck } from "lucide-react"
import { Messenger } from "@/components/bankeka/messenger"
import {
  listConversations,
  getThread,
  sendMessage,
  deleteMessage,
  findRecipientByEmail,
  getSupportContact,
} from "@/app/actions/bankeka"

export default function BankekaPage() {
  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 border-b border-border pb-5 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3">
          <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-primary/10">
            <MessageSquareText className="h-6 w-6 text-primary" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-foreground">Bankeka Messenger</h1>
            <p className="text-sm text-muted-foreground text-pretty">
              Secure, private messaging across the MCC Capital platform.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2">
          <ShieldCheck className="h-4 w-4 text-success" />
          <span className="text-xs text-muted-foreground">
            Conversations are private between you and the recipient.
          </span>
        </div>
      </div>

      <Messenger
        scope="client"
        fetchConversations={listConversations}
        fetchThread={getThread}
        send={sendMessage}
        deleteMessage={deleteMessage}
        findByEmail={findRecipientByEmail}
        fetchSupportContact={getSupportContact}
        attachmentsEnabled
        emptyHint="Message MCC Capital support, or start a private conversation with someone by entering their email address."
      />
    </div>
  )
}
