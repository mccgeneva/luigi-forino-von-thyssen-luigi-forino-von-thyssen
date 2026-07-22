"use client"

import { useState } from "react"
import { toast } from "sonner"
import { useActivityLog } from "@/components/activity-tracker"
import { exportToCsv } from "@/lib/export-utils"
import { generateTablePdf, tablePdfFilename } from "@/lib/table-pdf"
import { useHolderIdentity } from "@/lib/holder-identity"
import { usePdfViewer } from "@/lib/pdf-viewer"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { SwiftComposer, SWIFT_MESSAGE_TYPES, type SwiftSentSummary } from "@/components/dashboard/swift-composer"
import { parseSwiftMessage } from "@/lib/swift-mt"
import { submitSwiftForRouting } from "@/app/actions/swift-routing"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Globe,
  Send,
  FileText,
  Clock,
  CheckCircle2,
  AlertCircle,
  Search,
  Filter,
  Download,
  ArrowUpRight,
  ArrowDownLeft,
  Building2,
  Copy,
  Eye,
  Inbox,
  RefreshCw,
} from "lucide-react"

// Sample SWIFT messages
type SwiftMessage = {
  id: string
  type: string
  direction: string
  status: string
  sender: string
  receiver: string
  amount: string
  currency: string
  beneficiary: string
  beneficiaryAccount: string
  orderingCustomer: string
  date: string
  time: string
  reference: string
  valueDate: string
  ack: string
  raw?: string
  uetr?: string
}

const swiftMessages: SwiftMessage[] = []

const correspondentBanks = [
  { bic: "NWBKGB2L", name: "NatWest Bank", country: "United Kingdom", city: "London" },
  { bic: "CHASUS33", name: "JP Morgan Chase", country: "United States", city: "New York" },
  { bic: "UBSWCHZH", name: "UBS Switzerland", country: "Switzerland", city: "Zurich" },
  { bic: "HABORUMM", name: "HSBC Abu Dhabi", country: "UAE", city: "Abu Dhabi" },
  { bic: "DEUTDEFF", name: "Deutsche Bank", country: "Germany", city: "Frankfurt" },
  { bic: "BNPAFRPP", name: "BNP Paribas", country: "France", city: "Paris" },
  { bic: "CITIUS33", name: "Citibank", country: "United States", city: "New York" },
  { bic: "COBADEFF", name: "Commerzbank", country: "Germany", city: "Frankfurt" },
]

const messageTypeOptions = SWIFT_MESSAGE_TYPES.map((t) => t.code)

export default function SwiftPage() {
  const [searchQuery, setSearchQuery] = useState("")
  const [selectedType, setSelectedType] = useState("all")
  const [selectedDirection, setSelectedDirection] = useState("all")
  const [messages, setMessages] = useState<SwiftMessage[]>(swiftMessages)
  const [selectedMessage, setSelectedMessage] = useState<SwiftMessage | null>(null)
  const [activeTab, setActiveTab] = useState("inbox")

  const filteredMessages = messages.filter((msg) => {
    const matchesSearch =
      msg.id.toLowerCase().includes(searchQuery.toLowerCase()) ||
      msg.beneficiary.toLowerCase().includes(searchQuery.toLowerCase()) ||
      msg.reference.toLowerCase().includes(searchQuery.toLowerCase()) ||
      msg.sender.toLowerCase().includes(searchQuery.toLowerCase()) ||
      msg.receiver.toLowerCase().includes(searchQuery.toLowerCase())
    const matchesType = selectedType === "all" || msg.type === selectedType
    const matchesDirection = selectedDirection === "all" || msg.direction === selectedDirection
    return matchesSearch && matchesType && matchesDirection
  })

  const inboxMessages = filteredMessages.filter(m => m.direction === "incoming")
  const outboxMessages = filteredMessages.filter(m => m.direction === "outgoing")

  const getStatusColor = (status: string) => {
    switch (status) {
      case "delivered":
      case "received":
        return "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
      case "pending":
        return "bg-amber-500/10 text-amber-400 border-amber-500/20"
      case "processing":
        return "bg-blue-500/10 text-blue-400 border-blue-500/20"
      case "failed":
      case "nack":
        return "bg-red-500/10 text-red-400 border-red-500/20"
      default:
        return "bg-muted text-muted-foreground"
    }
  }

  const getStatusIcon = (status: string) => {
    switch (status) {
      case "delivered":
      case "received":
        return <CheckCircle2 className="h-3 w-3" />
      case "pending":
        return <Clock className="h-3 w-3" />
      case "processing":
        return <RefreshCw className="h-3 w-3 animate-spin" />
      case "failed":
      case "nack":
        return <AlertCircle className="h-3 w-3" />
      default:
        return null
    }
  }

  const logActivity = useActivityLog()
  const { show } = usePdfViewer()
  const { holderName, holderCompany, holderAddress } = useHolderIdentity()

  const handleExportPdf = () => {
    if (filteredMessages.length === 0) {
      toast.info("No messages to export", { description: "There are no SWIFT messages matching the current filters." })
      return
    }
    const doc = generateTablePdf({
      title: "SWIFT Message Log",
      refPrefix: "SWF",
      holderName,
      holderCompany,
      holderAddress,
      meta: [{ label: "Records", value: `${filteredMessages.length}` }],
      columns: [
        { key: "date", header: "Date" },
        { key: "id", header: "Message ID" },
        { key: "type", header: "MT" },
        { key: "direction", header: "Dir." },
        { key: "sender", header: "Sender BIC" },
        { key: "receiver", header: "Receiver BIC" },
        { key: "amount", header: "Amount", align: "right" },
        { key: "status", header: "Status" },
      ],
      rows: filteredMessages as unknown as Record<string, unknown>[],
      footNote: "SWIFT message log exported from the MCC Capital platform with the filters active at the time of export.",
    })
    show({ doc, filename: tablePdfFilename("SWIFT-Messages"), title: "SWIFT Message Log" })
    logActivity({
      action: `Exported ${filteredMessages.length} SWIFT message${filteredMessages.length === 1 ? "" : "s"} to PDF`,
      category: "SWIFT Messaging",
      details: {
        summary: `Client previewed/exported ${filteredMessages.length} SWIFT message record(s) as a professional PDF.`,
        recordCount: `${filteredMessages.length}`,
        format: "PDF",
      },
    })
  }

  const handleExportCsv = () => {
    const count = exportToCsv("swift-messages", filteredMessages, [
      { key: "id", label: "Message ID" },
      { key: "type", label: "MT Type" },
      { key: "direction", label: "Direction" },
      { key: "status", label: "Status" },
      { key: "sender", label: "Sender BIC" },
      { key: "receiver", label: "Receiver BIC" },
      { key: "amount", label: "Amount" },
      { key: "currency", label: "Currency" },
      { key: "beneficiary", label: "Beneficiary" },
      { key: "reference", label: "Reference" },
      { key: "date", label: "Date" },
      { key: "valueDate", label: "Value Date" },
    ])
    logActivity({
      action: `Exported ${count} SWIFT message${count === 1 ? "" : "s"} to CSV`,
      category: "SWIFT Messaging",
      details: {
        summary: `Client exported ${count} SWIFT message record${count === 1 ? "" : "s"} (current filters applied) to a CSV file.`,
        recordCount: `${count}`,
        format: "CSV",
      },
    })
  }

  const handleComposerDraft = ({ code, name }: { code: string; name: string }) => {
    logActivity({
      action: `Saved SWIFT ${code} as draft`,
      category: "SWIFT Messaging",
      details: {
        summary: `Client saved a SWIFT ${code} (${name}) as a draft.`,
        messageType: code,
      },
    })
  }

  const [isRefreshing, setIsRefreshing] = useState(false)

  const handleRefresh = () => {
    setIsRefreshing(true)
    setTimeout(() => setIsRefreshing(false), 600)
    logActivity({
      action: "Refreshed the SWIFT message queue",
      category: "SWIFT Messaging",
      details: {
        summary: "Client refreshed the SWIFT inbox and outbox queues.",
        refreshedAt: new Date().toLocaleString("en-GB"),
      },
    })
    toast.success("Message queue refreshed")
  }

  const copyMessage = (message: SwiftMessage) => {
    navigator.clipboard?.writeText(message.raw || JSON.stringify(message, null, 2))
    toast.success(`Copied ${message.id}`)
  }

  const downloadMessage = (message: SwiftMessage) => {
    exportToCsv(`swift-${message.id}`, [message])
    logActivity({
      action: `Downloaded SWIFT message ${message.id}`,
      category: "SWIFT Messaging",
      details: {
        summary: `Client downloaded the SWIFT message ${message.id} (${message.type}).`,
        messageId: message.id,
        messageType: message.type,
      },
    })
  }

  const handleComposerSent = ({
    code,
    name,
    category,
    uetr,
    raw,
    receiverBic: composerReceiverBic,
    amount: composerAmount,
    currency: composerCurrency,
    reference: composerReference,
  }: SwiftSentSummary) => {
    const parsed = parseSwiftMessage(raw)
    const senderBic = parsed.basicHeader?.senderBic || "MCCBCHZZ"
    const receiverBic = parsed.applicationHeader?.counterpartyBic || composerReceiverBic || ""
    const now = new Date()
    const amount = parsed.amount != null ? parsed.amount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : ""
    const newMessage: SwiftMessage = {
      id: `${code}-${now.getTime().toString().slice(-8)}`,
      type: code,
      direction: "outgoing",
      status: "processing",
      sender: senderBic,
      receiver: receiverBic,
      amount,
      currency: parsed.currency || "",
      beneficiary: parsed.beneficiary?.nameAndAddress?.[0] || parsed.beneficiary?.bic || parsed.beneficiaryInstitution?.bic || "",
      beneficiaryAccount: parsed.beneficiary?.account || "",
      orderingCustomer: parsed.orderingCustomer?.nameAndAddress?.[0] || "MCC Capital",
      date: now.toLocaleDateString("en-GB"),
      time: now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }),
      reference: parsed.senderReference || "",
      valueDate: parsed.valueDate || now.toLocaleDateString("en-GB"),
      ack: "pending",
      raw,
      uetr,
    }
    setMessages((prev) => [newMessage, ...prev])
    setActiveTab("outbox")
    logActivity({
      action: `Sent SWIFT ${code} \u2014 ${name}`,
      category: "SWIFT Messaging",
      details: {
        summary: `Client composed and sent a SWIFT ${code} (${name}) from MCC Capital (BIC MCCBCHZZ).`,
        messageType: code,
        messageName: name,
        messageCategory: category,
        senderBic,
        receiverBic: receiverBic || "(unknown)",
        uetr,
      },
    })

    // Submit the generated message to the routing & approval backbone. It is NOT
    // delivered to any counterparty until an administrator approves and routes
    // it to the chosen beneficiary. The client receives an immediate
    // confirmation email here.
    void (async () => {
      const res = await submitSwiftForRouting({
        messageType: code,
        messageName: name,
        category,
        uetr,
        raw,
        senderBic,
        receiverBic,
        amount: composerAmount,
        currency: composerCurrency,
        reference: composerReference || parsed.senderReference || null,
      })
      if (res.ok) {
        toast.success(`${code} submitted for routing`, {
          description: res.emailed
            ? "A confirmation has been emailed to you. An administrator will review and route it."
            : "An administrator will review and route it to the designated beneficiary.",
        })
      } else {
        toast.error("Could not submit for routing", { description: res.error })
      }
    })()
  }

  const MessagesTable = ({ messages }: { messages: typeof swiftMessages }) => (
    <Table>
      <TableHeader>
        <TableRow className="border-border hover:bg-transparent">
          <TableHead className="text-muted-foreground">Message ID</TableHead>
          <TableHead className="text-muted-foreground">Type</TableHead>
          <TableHead className="text-muted-foreground">Counterparty</TableHead>
          <TableHead className="text-muted-foreground">Amount</TableHead>
          <TableHead className="text-muted-foreground">Date/Time</TableHead>
          <TableHead className="text-muted-foreground">ACK</TableHead>
          <TableHead className="text-muted-foreground">Status</TableHead>
          <TableHead className="text-muted-foreground text-right">Actions</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {messages.length === 0 ? (
          <TableRow>
            <TableCell colSpan={8} className="text-center py-8 text-muted-foreground">
              No messages found
            </TableCell>
          </TableRow>
        ) : (
          messages.map((message) => (
            <TableRow key={message.id} className="border-border">
              <TableCell>
                <code className="text-xs bg-muted px-1.5 py-0.5 rounded text-foreground">
                  {message.id}
                </code>
              </TableCell>
              <TableCell>
                <Badge variant="outline" className="border-primary/30 text-primary">
                  {message.type}
                </Badge>
              </TableCell>
              <TableCell>
                <div>
                  <p className="text-sm font-medium text-foreground">{message.beneficiary}</p>
                  <p className="text-xs text-muted-foreground">
                    {message.direction === "outgoing" ? message.receiver : message.sender}
                  </p>
                </div>
              </TableCell>
              <TableCell>
                {message.amount !== "N/A" ? (
                  <span className="font-medium text-foreground">{message.currency} {message.amount}</span>
                ) : (
                  <span className="text-muted-foreground">-</span>
                )}
              </TableCell>
              <TableCell>
                <div>
                  <p className="text-sm text-foreground">{message.date}</p>
                  <p className="text-xs text-muted-foreground">{message.time}</p>
                </div>
              </TableCell>
              <TableCell>
                <Badge className={message.ack === "ACK" ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20" : "bg-amber-500/10 text-amber-400 border-amber-500/20"}>
                  {message.ack}
                </Badge>
              </TableCell>
              <TableCell>
                <Badge className={`${getStatusColor(message.status)} flex w-fit items-center gap-1`}>
                  {getStatusIcon(message.status)}
                  <span className="capitalize">{message.status}</span>
                </Badge>
              </TableCell>
              <TableCell className="text-right">
                <div className="flex items-center justify-end gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    onClick={() => setSelectedMessage(message)}
                  >
                    <Eye className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    onClick={() => copyMessage(message)}
                  >
                    <Copy className="h-4 w-4" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8"
                    onClick={() => downloadMessage(message)}
                  >
                    <Download className="h-4 w-4" />
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          ))
        )}
      </TableBody>
    </Table>
  )

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
              <Globe className="h-5 w-5 text-primary" />
            </div>
            <div>
              <h1 className="text-2xl font-semibold text-foreground">EuroSwift 7.0</h1>
              <p className="text-sm text-muted-foreground">
                SWIFT Messaging System (SR 2025) &mdash; Payments, Documentary Credits, Guarantees &amp; Securities
              </p>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={handleRefresh} disabled={isRefreshing}>
            <RefreshCw className={`mr-2 h-4 w-4 ${isRefreshing ? "animate-spin" : ""}`} />
            Refresh
          </Button>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm">
                  <Download className="mr-2 h-4 w-4" />
                  Export
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={handleExportPdf}>
                  <FileText className="mr-2 h-4 w-4" />
                  Export as PDF
                </DropdownMenuItem>
                <DropdownMenuItem onClick={handleExportCsv}>
                  <Download className="mr-2 h-4 w-4" />
                  Export as CSV
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
        </div>
      </div>

      {/* Stats */}
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <Card className="bg-card border-border">
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-muted-foreground uppercase tracking-wide">Total Messages</p>
                <p className="text-2xl font-semibold text-foreground">0</p>
              </div>
              <div className="rounded-lg bg-primary/10 p-2">
                <FileText className="h-4 w-4 text-primary" />
              </div>
            </div>
          </CardContent>
        </Card>
        <Card className="bg-card border-border">
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-muted-foreground uppercase tracking-wide">Sent Today</p>
                <p className="text-2xl font-semibold text-foreground">0</p>
              </div>
              <div className="rounded-lg bg-blue-500/10 p-2">
                <ArrowUpRight className="h-4 w-4 text-blue-400" />
              </div>
            </div>
          </CardContent>
        </Card>
        <Card className="bg-card border-border">
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-muted-foreground uppercase tracking-wide">Received Today</p>
                <p className="text-2xl font-semibold text-foreground">0</p>
              </div>
              <div className="rounded-lg bg-emerald-500/10 p-2">
                <ArrowDownLeft className="h-4 w-4 text-emerald-400" />
              </div>
            </div>
          </CardContent>
        </Card>
        <Card className="bg-card border-border">
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-muted-foreground uppercase tracking-wide">Pending ACK</p>
                <p className="text-2xl font-semibold text-foreground">0</p>
              </div>
              <div className="rounded-lg bg-amber-500/10 p-2">
                <Clock className="h-4 w-4 text-amber-400" />
              </div>
            </div>
          </CardContent>
        </Card>
        <Card className="bg-card border-border">
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs text-muted-foreground uppercase tracking-wide">NACK/Failed</p>
                <p className="text-2xl font-semibold text-foreground">0</p>
              </div>
              <div className="rounded-lg bg-red-500/10 p-2">
                <AlertCircle className="h-4 w-4 text-red-400" />
              </div>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Message Types - Compose with live FIN generation */}
      <SwiftComposer onSent={handleComposerSent} onSaveDraft={handleComposerDraft} />

      {/* Main Content */}
      <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-4">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <TabsList className="bg-card border border-border">
            <TabsTrigger value="inbox" className="gap-2">
              <Inbox className="h-4 w-4" />
              Inbox ({inboxMessages.length})
            </TabsTrigger>
            <TabsTrigger value="outbox" className="gap-2">
              <Send className="h-4 w-4" />
              Sent ({outboxMessages.length})
            </TabsTrigger>
            <TabsTrigger value="all" className="gap-2">
              <FileText className="h-4 w-4" />
              All Messages
            </TabsTrigger>
            <TabsTrigger value="correspondents" className="gap-2">
              <Building2 className="h-4 w-4" />
              Banks
            </TabsTrigger>
          </TabsList>
        </div>

        {/* Filters - shown for message tabs */}
        {(activeTab === "inbox" || activeTab === "outbox" || activeTab === "all") && (
          <Card className="bg-card border-border">
            <CardContent className="p-4">
              <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
                <div className="relative flex-1">
                  <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    placeholder="Search by ID, beneficiary, reference, or BIC..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="bg-background border-border pl-9 text-foreground"
                  />
                </div>
                <div className="flex gap-2">
                  <Select value={selectedType} onValueChange={setSelectedType}>
                    <SelectTrigger className="w-[130px] bg-background border-border text-foreground">
                      <Filter className="mr-2 h-4 w-4" />
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent className="bg-card border-border">
                      <SelectItem value="all">All Types</SelectItem>
                      {messageTypeOptions.map((mt) => (
                        <SelectItem key={mt} value={mt}>
                          {mt}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        <TabsContent value="inbox" className="space-y-4">
          <Card className="bg-card border-border">
            <CardContent className="p-0">
              <MessagesTable messages={inboxMessages} />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="outbox" className="space-y-4">
          <Card className="bg-card border-border">
            <CardContent className="p-0">
              <MessagesTable messages={outboxMessages} />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="all" className="space-y-4">
          <Card className="bg-card border-border">
            <CardContent className="p-0">
              <MessagesTable messages={filteredMessages} />
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="correspondents" className="space-y-4">
          <Card className="bg-card border-border">
            <CardHeader>
              <CardTitle className="text-foreground">Correspondent Banks</CardTitle>
              <CardDescription>Partner banks configured for SWIFT messaging</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                {correspondentBanks.map((bank) => (
                  <div
                    key={bank.bic}
                    className="flex items-start gap-4 rounded-lg border border-border bg-background p-4"
                  >
                    <div className="rounded-lg bg-primary/10 p-2.5">
                      <Building2 className="h-5 w-5 text-primary" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-medium text-foreground">{bank.name}</p>
                      <code className="text-xs text-primary bg-primary/10 px-1.5 py-0.5 rounded">
                        {bank.bic}
                      </code>
                      <p className="text-xs text-muted-foreground mt-1">
                        {bank.city}, {bank.country}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Message Detail Dialog */}
      <Dialog open={!!selectedMessage} onOpenChange={() => setSelectedMessage(null)}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto bg-card border-border">
          <DialogHeader>
            <div className="flex items-center justify-between">
              <DialogTitle className="text-foreground flex items-center gap-2">
                <Badge variant="outline" className="border-primary/30 text-primary">
                  {selectedMessage?.type}
                </Badge>
                {selectedMessage?.id}
              </DialogTitle>
              <Badge className={selectedMessage ? getStatusColor(selectedMessage.status) : ""}>
                {selectedMessage?.status}
              </Badge>
            </div>
            <DialogDescription>
              {selectedMessage?.direction === "outgoing" ? "Sent" : "Received"} on {selectedMessage?.date} at {selectedMessage?.time}
            </DialogDescription>
          </DialogHeader>
          {selectedMessage && (
            <div className="space-y-4">
              <div className="rounded-lg bg-background border border-border p-4 font-mono text-sm">
                <div className="grid gap-2">
                  <div className="flex justify-between border-b border-border pb-2">
                    <span className="text-muted-foreground">Sender:</span>
                    <span className="text-foreground">{selectedMessage.sender}</span>
                  </div>
                  <div className="flex justify-between border-b border-border pb-2">
                    <span className="text-muted-foreground">Receiver:</span>
                    <span className="text-foreground">{selectedMessage.receiver}</span>
                  </div>
                  <div className="flex justify-between border-b border-border pb-2">
                    <span className="text-muted-foreground">Reference:</span>
                    <span className="text-foreground">{selectedMessage.reference}</span>
                  </div>
                  {selectedMessage.amount !== "N/A" && (
                    <>
                      <div className="flex justify-between border-b border-border pb-2">
                        <span className="text-muted-foreground">Currency:</span>
                        <span className="text-foreground">{selectedMessage.currency}</span>
                      </div>
                      <div className="flex justify-between border-b border-border pb-2">
                        <span className="text-muted-foreground">Amount:</span>
                        <span className="text-foreground font-semibold">{selectedMessage.amount}</span>
                      </div>
                    </>
                  )}
                  <div className="flex justify-between border-b border-border pb-2">
                    <span className="text-muted-foreground">Value Date:</span>
                    <span className="text-foreground">{selectedMessage.valueDate}</span>
                  </div>
                  <div className="flex justify-between border-b border-border pb-2">
                    <span className="text-muted-foreground">Beneficiary:</span>
                    <span className="text-foreground">{selectedMessage.beneficiary}</span>
                  </div>
                  <div className="flex justify-between border-b border-border pb-2">
                    <span className="text-muted-foreground">Beneficiary Account:</span>
                    <span className="text-foreground">{selectedMessage.beneficiaryAccount}</span>
                  </div>
                  <div className="flex justify-between border-b border-border pb-2">
                    <span className="text-muted-foreground">Ordering Customer:</span>
                    <span className="text-foreground">{selectedMessage.orderingCustomer}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-muted-foreground">ACK Status:</span>
                    <Badge className={selectedMessage.ack === "ACK" ? "bg-emerald-500/10 text-emerald-400" : "bg-amber-500/10 text-amber-400"}>
                      {selectedMessage.ack}
                    </Badge>
                  </div>
                </div>
              </div>

              <div className="rounded-lg bg-muted/50 border border-border p-4">
                <p className="text-xs text-muted-foreground mb-2 uppercase tracking-wide">Raw Message Preview</p>
                <pre className="text-xs font-mono text-foreground whitespace-pre-wrap break-all">
{selectedMessage.raw
  ? selectedMessage.raw
  : `{1:F01${selectedMessage.sender}0000000000}
{2:I${selectedMessage.type}${selectedMessage.receiver}N}
{4:
:20:${selectedMessage.reference}
:23B:CRED
:32A:${selectedMessage.valueDate.replace(/-/g, '')}${selectedMessage.currency}${selectedMessage.amount}
:50K:/${selectedMessage.orderingCustomer}
:59:/${selectedMessage.beneficiaryAccount}
${selectedMessage.beneficiary}
:71A:SHA
-}`}
                </pre>
                {selectedMessage.uetr && (
                  <p className="mt-3 text-xs text-muted-foreground">
                    UETR (gpi): <code className="text-primary">{selectedMessage.uetr}</code>
                  </p>
                )}
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setSelectedMessage(null)}>
              Close
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                if (selectedMessage)
                  navigator.clipboard?.writeText(selectedMessage.raw || JSON.stringify(selectedMessage, null, 2))
              }}
            >
              <Copy className="mr-2 h-4 w-4" />
              Copy
            </Button>
            <Button
              variant="outline"
              onClick={() => {
                if (!selectedMessage) return
                exportToCsv("swift-message", [selectedMessage])
                logActivity({
                  action: `Exported SWIFT message ${selectedMessage.id} to CSV`,
                  category: "SWIFT Messaging",
                  details: {
                    summary: `Client exported the individual SWIFT message ${selectedMessage.id} (${selectedMessage.type}) to a CSV file.`,
                    messageId: selectedMessage.id,
                    messageType: selectedMessage.type,
                  },
                })
              }}
            >
              <Download className="mr-2 h-4 w-4" />
              Export
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
