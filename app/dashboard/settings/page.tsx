"use client"

import { useState } from "react"
import { Bell, Shield, Globe, Moon, Mail, Smartphone } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Separator } from "@/components/ui/separator"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useActivityLog } from "@/components/activity-tracker"
import { ChangePassword } from "@/components/settings/change-password"

export default function SettingsPage() {
  const [emailAlerts, setEmailAlerts] = useState(true)
  const [smsAlerts, setSmsAlerts] = useState(false)
  const [twoFactor, setTwoFactor] = useState(true)
  const [darkMode, setDarkMode] = useState(true)
  const logActivity = useActivityLog()

  const logSetting = (setting: string, value: boolean) =>
    logActivity({
      action: `${value ? "Enabled" : "Disabled"} setting: ${setting}`,
      category: "Settings",
      details: {
        summary: `Client ${value ? "enabled" : "disabled"} the "${setting}" preference.`,
        setting,
        newValue: value ? "Enabled" : "Disabled",
      },
    })

  const handleEmailAlerts = (v: boolean) => { setEmailAlerts(v); logSetting("Email alerts", v) }
  const handleSmsAlerts = (v: boolean) => { setSmsAlerts(v); logSetting("SMS alerts", v) }
  const handleTwoFactor = (v: boolean) => { setTwoFactor(v); logSetting("Two-factor authentication", v) }
  const handleDarkMode = (v: boolean) => { setDarkMode(v); logSetting("Dark mode", v) }

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Settings</h1>
        <p className="text-sm text-muted-foreground">
          Manage your preferences and account security
        </p>
      </div>

      {/* Notifications */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Bell className="h-4 w-4" /> Notifications
          </CardTitle>
          <CardDescription>Choose how you want to be notified</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Mail className="h-4 w-4 text-muted-foreground" />
              <div>
                <Label htmlFor="email-alerts">Email alerts</Label>
                <p className="text-xs text-muted-foreground">Payment and instrument updates</p>
              </div>
            </div>
            <Switch id="email-alerts" checked={emailAlerts} onCheckedChange={handleEmailAlerts} />
          </div>
          <Separator />
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Smartphone className="h-4 w-4 text-muted-foreground" />
              <div>
                <Label htmlFor="sms-alerts">SMS alerts</Label>
                <p className="text-xs text-muted-foreground">High-value transaction alerts</p>
              </div>
            </div>
            <Switch id="sms-alerts" checked={smsAlerts} onCheckedChange={handleSmsAlerts} />
          </div>
        </CardContent>
      </Card>

      {/* Security */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Shield className="h-4 w-4" /> Security
          </CardTitle>
          <CardDescription>Protect access to your account</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="two-factor">Two-factor authentication</Label>
              <p className="text-xs text-muted-foreground">Require a code at sign-in</p>
            </div>
            <Switch id="two-factor" checked={twoFactor} onCheckedChange={handleTwoFactor} />
          </div>
          <Separator />
          <ChangePassword />
        </CardContent>
      </Card>

      {/* Preferences */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Globe className="h-4 w-4" /> Preferences
          </CardTitle>
          <CardDescription>Regional and display settings</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <Label>Base currency</Label>
            <Select defaultValue="EUR">
              <SelectTrigger className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="EUR">EUR €</SelectItem>
                <SelectItem value="USD">USD $</SelectItem>
                <SelectItem value="GBP">GBP £</SelectItem>
                <SelectItem value="CHF">CHF</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Separator />
          <div className="flex items-center justify-between">
            <Label>Language</Label>
            <Select defaultValue="en">
              <SelectTrigger className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="en">English</SelectItem>
                <SelectItem value="es">Español</SelectItem>
                <SelectItem value="de">Deutsch</SelectItem>
                <SelectItem value="fr">Français</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Separator />
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <Moon className="h-4 w-4 text-muted-foreground" />
              <Label htmlFor="dark-mode">Dark mode</Label>
            </div>
            <Switch id="dark-mode" checked={darkMode} onCheckedChange={handleDarkMode} />
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
