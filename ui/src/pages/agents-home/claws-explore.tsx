import { createStore, For, onCleanup, Show } from "solid-js";
import type { IconName } from "../../components/icon-data.ts";
import {
  CatalogDiscoveryChip,
  CatalogDiscoveryChips,
  CatalogDiscoverySearch,
  CatalogDiscoverySection,
} from "../../components/solid/catalog-discovery.tsx";
import { HubPageHeader } from "../../components/solid/hub-page-header.tsx";
import { Icon } from "../../components/solid/icon.tsx";
import { SettingsPage } from "../../components/solid/settings-ui.tsx";
import { registerClawsEnglish } from "../../i18n/locales/en-claws.ts";
import { formatUiError } from "../../lib/format-error.ts";
import { canCallGatewayMethod } from "../../lib/gateway-methods.ts";
import { useApplication } from "../../lib/reactive/context.ts";
import { useGatewayPage } from "../../lib/reactive/gateway-page.ts";
import { registerEnglishCatalog, t } from "../../lib/reactive/i18n.ts";
import { ClawArtwork } from "./claw-artwork.tsx";
import { searchClaws, type ClawCatalogEntry } from "./claws-catalog-client.ts";
import "../../styles/agents-home.css";
import "../../styles/plugins.css";

registerEnglishCatalog(registerClawsEnglish);

// ClawHub's current Claw taxonomy. The "other" bucket is assigned by ClawHub.
const clawCategories = [
  ["", "clawsCatalog.categoryAll", "layoutGrid"],
  ["personal", "clawsCatalog.categoryPersonal", "users"],
  ["health", "clawsCatalog.categoryHealth", "activity"],
  ["travel", "clawsCatalog.categoryTravel", "globe"],
  ["productivity", "clawsCatalog.categoryProductivity", "listChecks"],
  ["research", "clawsCatalog.categoryResearch", "search"],
  ["engineering", "clawsCatalog.categoryEngineering", "braces"],
  ["governance", "clawsCatalog.categoryGovernance", "shield"],
  ["operations", "clawsCatalog.categoryOperations", "settings"],
  ["finance", "clawsCatalog.categoryFinance", "coins"],
  ["sales", "clawsCatalog.categorySales", "barChart"],
  ["product", "clawsCatalog.categoryProduct", "box"],
  ["people", "clawsCatalog.categoryPeople", "users"],
  ["other", "clawsCatalog.categoryOther", "layers"],
] as const;
const SECTION_SIZE = 8;
type ClawCategory = (typeof clawCategories)[number];
type ClawSection = { category: ClawCategory; entries: ClawCatalogEntry[] };

function ClawCard(props: {
  entry: ClawCatalogEntry;
  onSelect?: (entry: ClawCatalogEntry) => void;
}) {
  return (
    <article class="agents-home__claw-card oc-card" data-claws-entry>
      <button
        type="button"
        class="agents-home__claw-card-link"
        aria-label={`${t("clawsCatalog.review")} ${props.entry.displayName}`}
        disabled={!props.entry.latestVersion}
        onClick={() => props.onSelect?.(props.entry)}
      />
      <div class="agents-home__claw-head">
        <span class="agents-home__claw-art" aria-hidden="true">
          <ClawArtwork src={props.entry.iconUrl} />
        </span>
        <div class="agents-home__claw-identity">
          <h3>{props.entry.displayName}</h3>
          <span>{`@${props.entry.ownerHandle}`}</span>
        </div>
        <button
          type="button"
          class="btn btn--sm agents-home__claw-add oc-action oc-action-secondary"
          aria-label={t("clawsCatalog.addNamed", { name: props.entry.displayName })}
          disabled={!props.entry.latestVersion}
          onClick={() => props.onSelect?.(props.entry)}
        >
          {t("clawsCatalog.add")}
        </button>
      </div>
      <Show when={props.entry.summary}>
        <p class="agents-home__claw-summary">{props.entry.summary}</p>
      </Show>
    </article>
  );
}

export function ClawsExplore(props: { onSelect?: (entry: ClawCatalogEntry) => void }) {
  const context = useApplication();
  const [view, setView] = createStore<{
    entries: ClawCatalogEntry[];
    featured: ClawCatalogEntry[];
    sections: ClawSection[];
    query: string;
    category: string;
    loading: boolean;
    error: string | null;
  }>({
    entries: [],
    featured: [],
    sections: [],
    query: "",
    category: "",
    loading: false,
    error: null,
  });
  const updateView = (patch: Partial<typeof view>) => {
    setView((state) => {
      Object.assign(state, patch);
    });
  };
  let searchRevision = 0;
  let searchTimer: ReturnType<typeof setTimeout> | null = null;
  let loadedForConnection = false;
  const clearSearchTimer = () => {
    if (searchTimer) {
      clearTimeout(searchTimer);
      searchTimer = null;
    }
  };
  const canSearch = () =>
    canCallGatewayMethod(gateway.snapshot, "claws.catalog.search", "operator.read");
  const gateway = useGatewayPage({
    getGateway: () => context.gateway,
    onIdentityChange: () => updateView({ query: "", category: "" }),
    invalidateRequests: () => {
      searchRevision += 1;
      clearSearchTimer();
      loadedForConnection = false;
      updateView({ entries: [], featured: [], sections: [], loading: false, error: null });
    },
    onSnapshot: () => {
      if (gateway.connected && canSearch() && !loadedForConnection) {
        void loadCatalog();
      }
    },
  });
  onCleanup(clearSearchTimer);

  async function loadCatalog(category = view.category, query = view.query) {
    const scope = gateway.capture();
    if (!scope || !canSearch()) {
      return;
    }
    const revision = ++searchRevision;
    loadedForConnection = true;
    updateView({ entries: [], featured: [], sections: [], loading: true, error: null });
    try {
      const overview = !query.trim() && !category;
      const [entries, featured, sections] = await Promise.all([
        overview
          ? Promise.resolve([])
          : searchClaws(scope.client, query, undefined, { category: category || undefined }),
        overview
          ? searchClaws(scope.client, "", SECTION_SIZE, { featured: true })
          : Promise.resolve([]),
        overview
          ? Promise.all(
              clawCategories.slice(1).map(async (item): Promise<ClawSection> => ({
                category: item,
                entries: await searchClaws(scope.client, "", SECTION_SIZE, { category: item[0] }),
              })),
            )
          : Promise.resolve([]),
      ]);
      if (gateway.isCurrent(scope) && revision === searchRevision) {
        updateView({
          entries,
          featured,
          sections: sections.filter((section) => section.entries.length > 0),
        });
      }
    } catch (error) {
      if (gateway.isCurrent(scope) && revision === searchRevision) {
        updateView({ error: formatUiError(error, t("clawsCatalog.unavailable")) });
      }
    } finally {
      if (gateway.isCurrent(scope) && revision === searchRevision) {
        updateView({ loading: false });
      }
    }
  }

  function search(query: string) {
    searchRevision += 1;
    clearSearchTimer();
    updateView({ query, entries: [], featured: [], sections: [], loading: true, error: null });
    searchTimer = setTimeout(() => {
      searchTimer = null;
      void loadCatalog(view.category, query);
    }, 150);
  }

  function selectCategory(category: string) {
    if (category === view.category) {
      return;
    }
    searchRevision += 1;
    clearSearchTimer();
    updateView({ category, entries: [], featured: [], sections: [], loading: true, error: null });
    void loadCatalog(category);
  }

  const unavailable = () => gateway.connected && !canSearch();
  const overview = () => !view.query.trim() && !view.category;
  return (
    <openclaw-claws-explore>
      <HubPageHeader
        active="claws"
        subtitle={t("clawsCatalog.exploreDescription")}
        wide
        class="claws-catalog-header"
      />
      <SettingsPage wide carapace>
        <div class="agents-home">
          <section
            class="agents-home__explore plugin-catalog-results"
            data-claws-explore
            aria-label={t("tabs.claws")}
          >
            <CatalogDiscoverySearch>
              <input
                type="search"
                class="oc-input"
                data-claws-search
                aria-label={t("clawsCatalog.search")}
                placeholder={t("clawsCatalog.searchPlaceholder")}
                value={view.query}
                disabled={!gateway.connected || unavailable()}
                onInput={(event) => search(event.currentTarget.value)}
              />
            </CatalogDiscoverySearch>
            <CatalogDiscoveryChips label={t("clawsCatalog.categories")}>
              <For each={clawCategories}>
                {([slug, label, icon]) => (
                  <CatalogDiscoveryChip
                    active={view.category === slug}
                    onClick={() => selectCategory(slug)}
                    icon={<Icon name={icon as IconName} />}
                  >
                    {t(label)}
                  </CatalogDiscoveryChip>
                )}
              </For>
            </CatalogDiscoveryChips>
            <div class="plugin-catalog-results__body">
              <Show when={unavailable()}>
                <div class="callout warn" role="status">
                  {t("clawsCatalog.unavailable")}
                </div>
              </Show>
              <Show when={view.error}>
                <div class="callout danger" role="alert">
                  {view.error}
                  <button type="button" class="btn btn--sm" onClick={() => void loadCatalog()}>
                    {t("clawsCatalog.retry")}
                  </button>
                </div>
              </Show>
              <Show when={view.loading}>
                <div
                  class="plugin-catalog-grid"
                  role="status"
                  aria-label={t("clawsCatalog.loading")}
                >
                  <For each={[0, 1, 2, 3]}>
                    {() => <div class="agents-home__claw-skeleton" aria-hidden="true" />}
                  </For>
                </div>
              </Show>
              <Show
                when={
                  gateway.connected &&
                  !unavailable() &&
                  !view.loading &&
                  !view.error &&
                  view.entries.length === 0 &&
                  view.featured.length === 0 &&
                  view.sections.length === 0
                }
              >
                <p class="agents-home__claw-empty">{t("clawsCatalog.empty")}</p>
              </Show>
              <Show when={view.featured.length > 0 && overview()}>
                <CatalogDiscoverySection id="featured" title={t("clawsCatalog.featured")}>
                  <div class="plugin-catalog-grid" data-claws-featured>
                    <For each={view.featured} keyed={(entry) => entry.packageName}>
                      {(entry) => <ClawCard entry={entry()} onSelect={props.onSelect} />}
                    </For>
                  </div>
                </CatalogDiscoverySection>
              </Show>
              <Show when={overview()}>
                <For each={view.sections} keyed={(section) => section.category[0]}>
                  {(section) => (
                    <CatalogDiscoverySection
                      id={section().category[0]}
                      title={t(section().category[1])}
                      onViewAll={() => selectCategory(section().category[0])}
                      viewAllLabel={t("clawsCatalog.viewAll")}
                    >
                      <div class="plugin-catalog-grid" data-claws-category={section().category[0]}>
                        <For each={section().entries} keyed={(entry) => entry.packageName}>
                          {(entry) => <ClawCard entry={entry()} onSelect={props.onSelect} />}
                        </For>
                      </div>
                    </CatalogDiscoverySection>
                  )}
                </For>
              </Show>
              <Show when={!overview() && view.entries.length > 0}>
                <CatalogDiscoverySection
                  id={view.category || "results"}
                  title={
                    view.category
                      ? t(
                          clawCategories.find(([slug]) => slug === view.category)?.[1] ??
                            "clawsCatalog.categoryOther",
                        )
                      : t("clawsCatalog.results")
                  }
                >
                  <div class="plugin-catalog-grid" data-claws-results>
                    <For each={view.entries} keyed={(entry) => entry.packageName}>
                      {(entry) => <ClawCard entry={entry()} onSelect={props.onSelect} />}
                    </For>
                  </div>
                </CatalogDiscoverySection>
              </Show>
            </div>
          </section>
        </div>
      </SettingsPage>
    </openclaw-claws-explore>
  );
}
