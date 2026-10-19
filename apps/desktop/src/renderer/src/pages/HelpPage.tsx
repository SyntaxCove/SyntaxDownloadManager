import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Accordion,
  AccordionHeader,
  AccordionItem,
  AccordionPanel,
  Button,
  SearchBox,
  Tab,
  TabList,
  Text,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { ArrowExportLtrRegular, ArrowExportRtlRegular } from "@fluentui/react-icons";
import { useI18n } from "../i18n/context.js";
import { useDiagnosticsStore } from "../stores/diagnostics.js";
import {
  HELP_FAQ,
  HELP_TOPICS,
  HELP_TROUBLE,
  filterHelp,
  type HelpSearchItem,
} from "./help/content.js";

/**
 * Phase 27: in-app Help — topic guides, FAQ and troubleshooting, fully localized
 * (en/fa) through the Phase 21 i18n system. Content structure lives in
 * `help/content.ts`; this page only renders it: three tabs, a client-side search
 * (pure `filterHelp`), accordions for topics/FAQ, symptom cards with ordered steps
 * for troubleshooting, and an About card fed by the pull-only diagnostics store.
 */

type HelpTab = "topics" | "faq" | "trouble";

const useStyles = makeStyles({
  page: { display: "flex", flexDirection: "column", gap: "16px", maxWidth: "760px" },
  intro: { fontSize: tokens.fontSizeBase300, color: tokens.colorNeutralForeground3 },
  toolbar: { display: "flex", alignItems: "center", gap: "12px", flexWrap: "wrap" },
  search: { minWidth: "260px", flexGrow: 1, maxWidth: "420px" },
  section: {
    padding: "16px",
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground2,
    display: "flex",
    flexDirection: "column",
    gap: "12px",
  },
  about: {
    padding: "16px",
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground2,
    display: "flex",
    flexDirection: "column",
    gap: "8px",
  },
  list: { margin: "0", paddingInlineStart: "20px", display: "flex", flexDirection: "column", gap: "6px" },
  causeList: { margin: "0", paddingInlineStart: "20px", display: "flex", flexDirection: "column", gap: "4px" },
  card: {
    padding: "16px",
    borderRadius: tokens.borderRadiusMedium,
    backgroundColor: tokens.colorNeutralBackground2,
    display: "flex",
    flexDirection: "column",
    gap: "10px",
  },
  symptom: { fontWeight: tokens.fontWeightSemibold, fontSize: tokens.fontSizeBase400 },
  label: { fontWeight: tokens.fontWeightSemibold, color: tokens.colorNeutralForeground3 },
  meta: { fontSize: tokens.fontSizeBase200, color: tokens.colorNeutralForeground3 },
  body: { fontSize: tokens.fontSizeBase300, display: "flex", flexDirection: "column", gap: "8px" },
});

function TopicList({ shown }: { shown: (id: string) => boolean }): ReactNode {
  const styles = useStyles();
  const { t } = useI18n();
  return (
    <Accordion multiple collapsible defaultOpenItems={["getting-started"]}>
      {HELP_TOPICS.filter((topic) => shown(topic.id)).map((topic) => (
        <AccordionItem key={topic.id} value={topic.id}>
          <AccordionHeader>{t(topic.titleKey)}</AccordionHeader>
          <AccordionPanel>
            <ul className={styles.list}>
              {topic.points.map((p) => (
                <li key={p}>
                  <Text size={300}>{t(p)}</Text>
                </li>
              ))}
            </ul>
          </AccordionPanel>
        </AccordionItem>
      ))}
    </Accordion>
  );
}

function FaqList({ shown }: { shown: (id: string) => boolean }): ReactNode {
  const styles = useStyles();
  const { t } = useI18n();
  return (
    <Accordion multiple collapsible>
      {HELP_FAQ.filter((entry) => shown(entry.id)).map((entry) => (
        <AccordionItem key={entry.id} value={entry.id}>
          <AccordionHeader>{t(entry.qKey)}</AccordionHeader>
          <AccordionPanel>
            <Text size={300} className={styles.body}>
              {t(entry.aKey)}
            </Text>
          </AccordionPanel>
        </AccordionItem>
      ))}
    </Accordion>
  );
}

function TroubleList({
  shown,
  onOpenDiagnostics,
}: {
  shown: (id: string) => boolean;
  onOpenDiagnostics?: () => void;
}): ReactNode {
  const styles = useStyles();
  const { t, dir } = useI18n();
  const ArrowIcon = dir === "rtl" ? ArrowExportRtlRegular : ArrowExportLtrRegular;
  return (
    <>
      {HELP_TROUBLE.filter((entry) => shown(entry.id)).map((entry) => (
        <section key={entry.id} className={styles.card} aria-labelledby={`help-trouble-${entry.id}`}>
          <Text id={`help-trouble-${entry.id}`} as="h3" className={styles.symptom}>
            {t(entry.symptomKey)}
          </Text>
          <div>
            <Text className={styles.label}>{t("help.trouble.causes")}</Text>
            <ul className={styles.causeList}>
              {entry.causes.map((c) => (
                <li key={c}>
                  <Text size={300}>{t(c)}</Text>
                </li>
              ))}
            </ul>
          </div>
          <div>
            <Text className={styles.label}>{t("help.trouble.steps")}</Text>
            <ol className={styles.list}>
              {entry.steps.map((s) => (
                <li key={s}>
                  <Text size={300}>{t(s)}</Text>
                </li>
              ))}
            </ol>
          </div>
          {entry.openDiagnostics && onOpenDiagnostics ? (
            <div>
              <Button
                appearance="subtle"
                size="small"
                icon={<ArrowIcon />}
                onClick={onOpenDiagnostics}
              >
                {t("help.openDiagnostics")}
              </Button>
            </div>
          ) : null}
        </section>
      ))}
    </>
  );
}

export function HelpPage({ onOpenDiagnostics }: { onOpenDiagnostics?: () => void }): ReactNode {
  const styles = useStyles();
  const { t } = useI18n();
  const [tab, setTab] = useState<HelpTab>("topics");
  const [query, setQuery] = useState("");

  // About card: same pull-only diagnostics store the Diagnostics page uses.
  const report = useDiagnosticsStore((s) => s.report);
  const loadReport = useDiagnosticsStore((s) => s.loadReport);
  useEffect(() => {
    if (!report) void loadReport();
  }, [report, loadReport]);

  const visible = useMemo<"all" | Set<string>>(() => {
    let items: readonly HelpSearchItem[];
    if (tab === "topics") {
      items = HELP_TOPICS.map((d) => ({
        id: d.id,
        text: [d.titleKey, ...d.points].map((k) => t(k)).join(" "),
      }));
    } else if (tab === "faq") {
      items = HELP_FAQ.map((d) => ({ id: d.id, text: `${t(d.qKey)} ${t(d.aKey)}` }));
    } else {
      items = HELP_TROUBLE.map((d) => ({
        id: d.id,
        text: [...d.causes, ...d.steps, t(d.symptomKey)].map((k) => t(k)).join(" "),
      }));
    }
    const ids = filterHelp(query, items);
    return ids.length === items.length ? "all" : new Set(ids);
  }, [tab, query, t]);

  const shown = (id: string): boolean => visible === "all" || visible.has(id);
  const empty = visible !== "all" && visible.size === 0;

  return (
    <div className={styles.page}>
      <Text as="h1" weight="semibold" size={500}>
        {t("help.page.title")}
      </Text>
      <Text className={styles.intro}>{t("help.page.intro")}</Text>

      <div className={styles.toolbar}>
        <SearchBox
          className={styles.search}
          placeholder={t("help.search.placeholder")}
          aria-label={t("help.search.placeholder")}
          value={query}
          onChange={(_, data) => setQuery(data.value)}
        />
        <TabList
          selectedValue={tab}
          onTabSelect={(_, data) => setTab((data.value as HelpTab) ?? "topics")}
          aria-label={t("help.page.title")}
        >
          <Tab value="topics">{t("help.tab.topics")}</Tab>
          <Tab value="faq">{t("help.tab.faq")}</Tab>
          <Tab value="trouble">{t("help.tab.trouble")}</Tab>
        </TabList>
      </div>

      {empty ? <Text className={styles.intro}>{t("help.search.noResults")}</Text> : null}

      {tab === "topics" && !empty ? <TopicList shown={shown} /> : null}
      {tab === "faq" && !empty ? <FaqList shown={shown} /> : null}
      {tab === "trouble" && !empty ? (
        <TroubleList shown={shown} onOpenDiagnostics={onOpenDiagnostics} />
      ) : null}

      {report ? (
        <section className={styles.about} aria-labelledby="help-about-title">
          <Text id="help-about-title" as="h2" weight="semibold" size={400}>
            {t("help.about.title")}
          </Text>
          <Text className={styles.meta}>
            {t("help.about.version")}: {report.app.version} · {t("help.about.contract")}: v
            {report.versions.contract}
          </Text>
        </section>
      ) : null}
    </div>
  );
}
