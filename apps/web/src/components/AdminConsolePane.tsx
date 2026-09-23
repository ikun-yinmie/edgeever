import { useState } from "react";
import { ArrowLeft, Database, KeyRound, Mail, ShieldCheck, Users, UsersRound } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Navigate, useNavigate } from "react-router";
import { GroupManagementCard } from "@/components/settings/GroupManagementCard";
import { InstanceAdminCard } from "@/components/settings/InstanceAdminCard";
import { ObjectStorageCard } from "@/components/settings/ObjectStorageCard";
import { RegistrationInvitesCard } from "@/components/settings/RegistrationInvitesCard";
import { UserManagementCard } from "@/components/settings/UserManagementCard";
import { Button } from "@/components/ui/button";
import type { AuthUser } from "@edgeever/shared";

type AdminTabKey = "members" | "groups" | "invites" | "registration" | "storage";

export const AdminConsolePane = ({ user }: { user: AuthUser | null }) => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState<AdminTabKey>("members");

  if (!user || user.role !== "owner") {
    return <Navigate to="/" replace />;
  }

  const tabs: { key: AdminTabKey; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
    { key: "members", label: t("adminConsole.navMembers"), icon: Users },
    { key: "groups", label: t("adminConsole.navGroups"), icon: UsersRound },
    { key: "invites", label: t("adminConsole.navInvites"), icon: KeyRound },
    { key: "registration", label: t("adminConsole.navRegistration"), icon: Mail },
    { key: "storage", label: t("adminConsole.navStorage"), icon: Database },
  ];

  return (
    <main className="flex h-[100dvh] flex-col bg-slate-50 text-slate-900">
      <header className="flex items-center gap-3 border-b border-slate-200 bg-card px-4 py-3 sm:px-6">
        <Button
          aria-label={t("adminConsole.backToWorkspace")}
          className="h-9 w-9 shrink-0 p-0"
          onClick={() => navigate("/")}
          size="icon"
          variant="ghost"
        >
          <ArrowLeft className="h-4.5 w-4.5" />
        </Button>
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-500 text-white shadow-[0_8px_18px_-8px_rgb(var(--brand-green-rgb)/0.45)]">
          <ShieldCheck className="h-5 w-5" />
        </div>
        <div className="min-w-0">
          <h1 className="truncate text-base font-bold leading-tight text-slate-900">{t("adminConsole.pageTitle")}</h1>
          <p className="truncate text-xs text-slate-500">{t("adminConsole.pageSubtitle")}</p>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <nav className="hidden w-56 shrink-0 border-r border-slate-200 bg-card p-3 sm:block">
          <div className="space-y-1">
            {tabs.map((tab) => (
              <button
                className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition ${
                  activeTab === tab.key
                    ? "bg-emerald-50 text-emerald-800"
                    : "text-slate-600 hover:bg-slate-50 hover:text-slate-900"
                }`}
                key={tab.key}
                onClick={() => setActiveTab(tab.key)}
                type="button"
              >
                <tab.icon className="h-4 w-4" />
                {tab.label}
              </button>
            ))}
          </div>
        </nav>

        <div className="min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-3xl space-y-4 p-4 sm:p-6">
            <div className="flex gap-2 sm:hidden">
              {tabs.map((tab) => (
                <button
                  className={`flex flex-1 items-center justify-center gap-2 rounded-lg border px-3 py-2 text-sm font-medium transition ${
                    activeTab === tab.key
                      ? "border-emerald-200 bg-emerald-50 text-emerald-800"
                      : "border-slate-200 bg-card text-slate-600"
                  }`}
                  key={tab.key}
                  onClick={() => setActiveTab(tab.key)}
                  type="button"
                >
                  <tab.icon className="h-4 w-4" />
                  {tab.label}
                </button>
              ))}
            </div>

            {activeTab === "members" ? (
              <UserManagementCard currentUserId={user.id} demoMode={false} />
            ) : activeTab === "groups" ? (
              <GroupManagementCard />
            ) : activeTab === "invites" ? (
              <RegistrationInvitesCard />
            ) : activeTab === "registration" ? (
              <InstanceAdminCard />
            ) : (
              <ObjectStorageCard demoMode={false} />
            )}
          </div>
        </div>
      </div>
    </main>
  );
};
