"use client"

import * as React from "react"
import { BookOpenIcon, GlobeIcon, LibraryBigIcon, XIcon } from "lucide-react"

import { pickerTrigger, PickerChevron } from "@/components/model-picker"
import { TreeRowsSkeleton } from "@/components/page-skeletons"
import { Button } from "@/components/ui/button"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import {
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import {
  KNOWLEDGE_MODES,
  NO_KNOWLEDGE,
  readKnowledgeChoice,
  sessionChoiceKey,
  useKnowledgeBases,
  writeKnowledgeChoice,
  type KnowledgeChoice,
  type KnowledgeMode,
} from "@/lib/knowledge-api"
import { sectionById, sectionHref } from "@/lib/sections"
import { TransitionLink } from "@/lib/view-transitions"
import { useWorkspaceHash } from "@/lib/workspace-context"

export const MODE_INFO: Record<KnowledgeMode, { label: string; hint: string; icon: React.ComponentType<{ className?: string }> }> = {
  web: {
    label: "Web only",
    hint: "An ordinary turn: no knowledge bases, the agent's own tools and the web.",
    icon: GlobeIcon,
  },
  knowledge_web: {
    label: "Knowledge & Web",
    hint: "The agent reads the picked knowledge bases first, and may search the web to fill gaps.",
    icon: LibraryBigIcon,
  },
  knowledge: {
    label: "Knowledge only",
    hint: "The agent answers from the picked knowledge bases alone; its web tools are switched off.",
    icon: BookOpenIcon,
  },
}

/**
 * A chat's pick, remembered in this browser per chat. Every chat starts on
 * Web only.
 */
export function useKnowledgeChoice(
  workspaceId: string | undefined,
  /** The chat's own key: a project session's hash, or a session workspace's project id. */
  chatKey: string,
): [KnowledgeChoice, (next: KnowledgeChoice) => void] {
  const [choice, setChoice] = React.useState<KnowledgeChoice>(NO_KNOWLEDGE)
  React.useEffect(() => {
    if (!workspaceId) return
    setChoice(readKnowledgeChoice(sessionChoiceKey(chatKey)) ?? NO_KNOWLEDGE)
  }, [workspaceId, chatKey])
  const update = React.useCallback(
    (next: KnowledgeChoice) => {
      setChoice(next)
      writeKnowledgeChoice(sessionChoiceKey(chatKey), next)
    },
    [chatKey],
  )
  return [choice, update]
}

/**
 * "Knowledge" in the composer's + menu: a submenu, opened by hovering or
 * clicking it, of where the agent may look. Must sit inside a
 * `DropdownMenuContent`.
 */
export function KnowledgeModeSubmenu({
  value,
  onChange,
}: {
  value: KnowledgeChoice
  onChange: (next: KnowledgeChoice) => void
}) {
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger data-testid="knowledge-mode">
        <LibraryBigIcon />
        Knowledge
        <span className="text-muted-foreground ml-auto truncate pl-2 text-xs">{MODE_INFO[value.mode].label}</span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="w-48">
        <DropdownMenuRadioGroup
          value={value.mode}
          onValueChange={(mode) => {
            if (KNOWLEDGE_MODES.includes(mode as KnowledgeMode)) onChange({ ...value, mode: mode as KnowledgeMode })
          }}
        >
          {KNOWLEDGE_MODES.map((mode) => {
            const { label, hint, icon: Icon } = MODE_INFO[mode]
            return (
              <DropdownMenuRadioItem key={mode} value={mode} title={hint} closeOnClick>
                <Icon />
                {label}
              </DropdownMenuRadioItem>
            )
          })}
        </DropdownMenuRadioGroup>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}

/**
 * The knowledge bases a Knowledge & Web or Knowledge only chat answers
 * from: a searchable list like the model picker's, where any number can be
 * ticked. The popover stays open while picking. Its cross puts the chat back
 * on Web only.
 */
export function KnowledgeBaseSelect({
  workspaceId,
  value,
  onChange,
  disabled,
}: {
  workspaceId: string
  value: KnowledgeChoice
  onChange: (next: KnowledgeChoice) => void
  disabled?: boolean
}) {
  const bases = useKnowledgeBases(workspaceId)
  const ws = useWorkspaceHash()
  const [open, setOpen] = React.useState(false)
  const [query, setQuery] = React.useState("")

  // Only bases that still exist count: one deleted since it was picked is
  // dropped from the label, and from what is kept once the pick changes.
  const live = value.baseIds.filter((id) => bases.data?.some((b) => b.id === id) ?? true)
  const label =
    live.length === 0
      ? "Select knowledge"
      : live.length === 1
        ? (bases.data?.find((b) => b.id === live[0])?.name ?? "1 base")
        : `${live.length} bases`
  const ModeIcon = MODE_INFO[value.mode].icon

  const q = query.trim().toLowerCase()
  const shown = (bases.data ?? []).filter(
    (b) => !q || b.name.toLowerCase().includes(q) || b.description.toLowerCase().includes(q),
  )

  const toggle = (id: string) =>
    onChange({
      ...value,
      baseIds: live.includes(id) ? live.filter((b) => b !== id) : [...live, id],
    })

  return (
    <div className="flex min-w-0 shrink items-center">
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next)
          if (!next) setQuery("")
        }}
      >
        <PopoverTrigger
          render={
            <Button
              {...pickerTrigger("inline", live.length === 0 ? "text-muted-foreground" : "text-foreground font-medium")}
              role="combobox"
              aria-expanded={open}
              aria-label="Knowledge bases"
              data-testid="knowledge-select"
              title={`${MODE_INFO[value.mode].label}: ${MODE_INFO[value.mode].hint}`}
              disabled={disabled}
            />
          }
        >
          <ModeIcon className="size-3.5 shrink-0" />
          <span className="truncate">{label}</span>
          <PickerChevron look="inline" />
        </PopoverTrigger>
        <PopoverContent side="top" align="start" className="w-80 p-0">
          <Command shouldFilter={false}>
            <CommandInput placeholder="Search knowledge bases…" value={query} onValueChange={setQuery} />
            <CommandList className="max-h-72">
              {bases.isPending ? (
                <div className="p-2">
                  <TreeRowsSkeleton rows={3} dense />
                </div>
              ) : bases.isError ? (
                <p className="text-destructive px-3 py-2 text-xs">{bases.error.message}</p>
              ) : bases.data.length === 0 ? (
                <p className="text-muted-foreground px-3 py-3 text-xs">
                  No knowledge bases yet.{" "}
                  <TransitionLink
                    href={sectionHref(sectionById("knowledge"), ws)}
                    className="text-foreground underline underline-offset-2"
                  >
                    Make one
                  </TransitionLink>{" "}
                  and add documents to it.
                </p>
              ) : (
                <>
                  <CommandEmpty>No knowledge base matches that.</CommandEmpty>
                  <CommandGroup heading={`${MODE_INFO[value.mode].label} · pick any number`}>
                    {shown.map((base) => (
                      <CommandItem
                        key={base.id}
                        value={base.id}
                        data-checked={live.includes(base.id)}
                        onSelect={() => toggle(base.id)}
                      >
                        <LibraryBigIcon className="text-muted-foreground" />
                        <span className="min-w-0 flex-1 truncate">{base.name}</span>
                        <span className="text-muted-foreground shrink-0 text-[10px] tabular-nums">
                          {base.documentCount} {base.documentCount === 1 ? "doc" : "docs"}
                        </span>
                      </CommandItem>
                    ))}
                  </CommandGroup>
                </>
              )}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
      <button
        type="button"
        disabled={disabled}
        onClick={() => onChange({ mode: "web", baseIds: [] })}
        title="Back to Web only"
        className="text-muted-foreground hover:text-foreground flex size-6 shrink-0 items-center justify-center rounded-full"
      >
        <XIcon className="size-3" />
        <span className="sr-only">Stop using knowledge bases</span>
      </button>
    </div>
  )
}
