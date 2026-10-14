"use client";

import Link from "next/link";
import { HelpCircle, Search } from "lucide-react";
import { AuthGuard } from "@/components/auth/auth-guard";
import { ComposeProvider } from "@/components/compose/compose-context";
import { FloatingComposer } from "@/components/compose/floating-composer";
import { MailboxProvider } from "@/components/mailbox-provider";
import { MailboxSelector } from "@/components/mailbox-selector";
import { LicenseIndicator } from "@/components/license-indicator";
import { AdminNav } from "@/components/admin-nav";
import { SidebarDrawer, SidebarMenuButton } from "@/components/sidebar-drawer";
import { SidebarProvider } from "@/components/sidebar-state";
import { ShortcutsProvider } from "@/components/shortcuts";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <AuthGuard requireMailbox requireRole="admin">
      <SidebarProvider expandedWidth={256}>
      <MailboxProvider>
        <ComposeProvider>
          <ShortcutsProvider>
          <div className="grid h-dvh grid-cols-[minmax(0,1fr)] md:grid-cols-[var(--sidebar-width)_minmax(0,1fr)] overflow-hidden bg-[#f6f8fc] transition-[grid-template-columns] duration-200">
            <SidebarDrawer className="min-h-0 overflow-y-auto overscroll-contain px-3 py-4 scrollbar-gutter-stable">
              <AdminNav />
            </SidebarDrawer>
            <div className="flex min-h-0 min-w-0 flex-col">
              <header className="flex h-14 shrink-0 items-center px-2 md:hidden">
                <SidebarMenuButton />
              </header>
              <span className="fixed top-2 right-4 flex items-center gap-4 max-md:top-1.5 max-md:right-3 max-md:z-30">
                <LicenseIndicator />
                <MailboxSelector />
              </span>
              <main className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain rounded-tl-3xl px-6 py-10 scrollbar-gutter-stable max-md:px-4 max-md:py-6 lg:px-12">
                <div className="w-full max-w-3xl">{children}</div>
              </main>
            </div>
            <FloatingComposer />
          </div>
          </ShortcutsProvider>
        </ComposeProvider>
      </MailboxProvider>
      </SidebarProvider>
    </AuthGuard>
  );
}
