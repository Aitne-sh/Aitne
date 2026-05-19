"use client";

import { SlackCard } from "@/components/connections/slack-card";
import { TelegramCard } from "@/components/connections/telegram-card";
import { DiscordCard } from "@/components/connections/discord-card";
import { WhatsAppCard } from "@/components/connections/whatsapp-card";
import { DestinationSelector } from "@/components/connections/destination-selector";
import { WizardStepFrame } from "./wizard-step-frame";

interface MessagingStepProps {
  onNext: () => void;
  onBack?: () => void;
}

export function MessagingStep({ onNext, onBack }: MessagingStepProps) {
  return (
    <WizardStepFrame
      title="Messaging Channels"
      description="Connect the apps you'll use to message your agent. Hook up only the ones you actually use."
      onNext={onNext}
      onBack={onBack}
      skipLabel="Skip"
      maxWidth="max-w-2xl"
    >
      <div className="space-y-4">
        <SlackCard />
        <TelegramCard />
        <DiscordCard />
        <WhatsAppCard />
        <DestinationSelector />
      </div>
    </WizardStepFrame>
  );
}
