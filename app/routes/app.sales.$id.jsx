import { json, redirect } from "@remix-run/node";
import {
  useFetcher,
  useLoaderData,
  useLocation,
  useNavigate,
  useParams,
  useRevalidator,
  useSearchParams,
} from "@remix-run/react";
import { useEffect, useMemo, useState } from "react";
import {
  Badge,
  Banner,
  BlockStack,
  Box,
  Button,
  Card,
  IndexTable,
  InlineStack,
  Layout,
  Modal,
  Page,
  Pagination,
  Spinner,
  Text,
  TextField,
  Toast,
} from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";
import db from "../db.server";
import { authenticate } from "../shopify.server";
import {
  endSaleRecord,
  executeSaleConditionChangeRecord,
} from "../lib/sales.server";
import {
  canRollbackSale,
  getSaleStatusDisplay,
  normalizeSaleStatus,
  SALE_STATUS,
} from "../lib/sale-status";
import {
  generateProductReport,
} from "../lib/product-reports.server";
import { formatAutoReapplyInterval } from "../lib/task-auto-reapply";
import {
  normalizeShop,
  REPORT_TYPES,
} from "../lib/product-reports";
import { commitFlashSession, getFlashSession } from "../lib/flash.server";
import { withShopifyEmbeddedParams } from "../lib/shopify-embedded-url";
import NewSalePage, {
  action as newSaleAction,
  loader as newSaleLoader,
} from "./app.sales.new";

const LOGS_PER_PAGE = 8;
const EDIT_SALE_URL = "/app/sales/new";

const pageOperationOverlayStyle = {
  position: "fixed",
  inset: 0,
  zIndex: 520,
  display: "grid",
  placeItems: "center",
  background: "rgba(255, 255, 255, 0.56)",
  pointerEvents: "none",
};

const pageOperationSpinnerStyle = {
  display: "grid",
  placeItems: "center",
};

const confirmationModalContentStyle = {
  fontSize: 16,
  fontWeight: 600,
  lineHeight: 1.45,
};

function isNewSaleRoute(params) {
  return String(params.id || "").toLowerCase() === "new";
}

export const loader = async ({ request, params }) => {
  if (isNewSaleRoute(params)) {
    return newSaleLoader({ request, params });
  }

  const { session } = await authenticate.admin(request);
  const flashSession = await getFlashSession(request);
  const saleId = Number(params.id);

  if (!Number.isInteger(saleId) || saleId <= 0) {
    throw new Response("Sale not found", { status: 404 });
  }

  const sale = await db.sale.findFirst({
    where: {
      id: saleId,
      shop: session.shop,
    },
  });

  if (!sale) {
    throw new Response("Sale not found", { status: 404 });
  }

  const shopCurrency =
    (
      await db.shop.findUnique({
        where: { shop: session.shop },
        select: { currency: true },
      })
    )?.currency || "";

  return json({
    sale,
    shop: session.shop,
    shopCurrency,
    toastMessage: flashSession.get("toast") || "",
  }, {
    headers: {
      "Set-Cookie": await commitFlashSession(flashSession),
    },
  });
};

export const action = async ({ request, params }) => {
  if (isNewSaleRoute(params)) {
    return newSaleAction({ request, params });
  }

  const { admin, session } = await authenticate.admin(request);
  const shop = normalizeShop(session.shop);
  const saleId = Number(params.id);
  const formData = await request.formData();
  const intent = String(formData.get("intent") || "");

  if (!Number.isInteger(saleId) || saleId <= 0) {
    throw new Response("Sale not found", { status: 404 });
  }

  const sale = await db.sale.findFirst({
    where: {
      id: saleId,
      shop: session.shop,
    },
  });

  if (!sale) {
    throw new Response("Sale not found", { status: 404 });
  }

  if (intent === "generate_margin_report") {
    if (!shop) {
      return json({ ok: false, message: "Shop is required." }, { status: 400 });
    }

    const report = await generateProductReport(admin, shop, REPORT_TYPES.margin);

    return json({
      ok: true,
      type: REPORT_TYPES.margin,
      message: `Margin report generated with ${report.totalRows} rows.`,
      latestReportUrl: report.url,
    });
  }

  if (intent === "generate_discount_report") {
    if (!shop) {
      return json({ ok: false, message: "Shop is required." }, { status: 400 });
    }

    const report = await generateProductReport(admin, shop, REPORT_TYPES.discount);

    return json({
      ok: true,
      type: REPORT_TYPES.discount,
      message: `Discount report generated with ${report.totalRows} rows.`,
      latestReportUrl: report.url,
    });
  }

  if (intent === "check_changes") {
    if (normalizeSaleStatus(sale.status) !== SALE_STATUS.COMPLETED) {
      return json(
        { ok: false, message: "Only active sales can check changes." },
        { status: 400 },
      );
    }

    await db.sale.updateMany({
      where: { id: sale.id, shop: session.shop },
      data: {
        status: "checking_changes",
        executionSummary: {
          ...(sale.executionSummary || {}),
          status: "Checking changes",
          progress: 0,
        },
      },
    });

    const tracked = await executeSaleConditionChangeRecord(admin, sale);
    const checkedAt = new Date().toISOString();

    await db.sale.updateMany({
      where: { id: sale.id, shop: session.shop },
      data: {
        status: SALE_STATUS.COMPLETED,
        executionSummary: {
          ...(sale.executionSummary || {}),
          originalVariants: tracked.originalVariants,
          originalMarketPrices:
            tracked.originalMarketPrices ||
            sale.executionSummary?.originalMarketPrices ||
            [],
          progress: 100,
          trackConditionLastRunAt: checkedAt,
          trackConditionLastResult: {
            ok: tracked.ok,
            analyzedVariants: tracked.analyzedVariants,
            addedVariants: tracked.addedVariants,
            removedVariants: tracked.removedVariants,
            taggedProducts: tracked.taggedProducts,
            errors: tracked.errors,
          },
          logs: [
            ...((sale.executionSummary || {}).logs || []),
            ...(tracked.logs || []),
          ],
        },
      },
    });

    return json({ ok: tracked.ok });
  }

  if (intent === "rollback_sale") {
    if (canRollbackSale(sale)) {
      await db.sale.updateMany({
        where: { id: sale.id, shop: session.shop },
        data: {
          status: SALE_STATUS.CANCELING,
          executionSummary: {
            ...(sale.executionSummary || {}),
            status: "Canceling",
            progress: 0,
            rollbackStartedAt: new Date().toISOString(),
          },
        },
      });

      const ended = await endSaleRecord(admin, sale);

      await db.sale.updateMany({
        where: { id: sale.id, shop: session.shop },
        data: {
          status: ended.ok ? SALE_STATUS.CANCELED : SALE_STATUS.FAILED,
          executionSummary: {
            ...(sale.executionSummary || {}),
            status: ended.ok ? "Canceled" : "Failed",
            progress: 100,
            rollback: ended,
            ended,
            errors: ended.errors || [],
            rollbackCompletedAt: new Date().toISOString(),
          },
          completedAt: new Date(),
        },
      });

      return json({
        ok: ended.ok,
        message: ended.ok ? "Sale disabled." : "Sale disable completed with errors.",
      });
    }

    return json(
      { ok: false, message: "Only completed sales with rollback data can be rolled back." },
      { status: 400 },
    );
  }

  if (intent === "duplicate_sale") {
    const copy = await db.sale.create({
      data: {
        shop: session.shop,
        title: `${sale.title} copy`,
        status: SALE_STATUS.PENDING,
        changeType: sale.changeType,
        applyToFixedPrices: sale.applyToFixedPrices,
        markets: sale.markets,
        priceChange: sale.priceChange,
        compareAtPriceChange: sale.compareAtPriceChange,
        applyScope: sale.applyScope,
        excludeScope: sale.excludeScope,
        discountedScope: sale.discountedScope,
        applyResources: sale.applyResources,
        excludeResources: sale.excludeResources,
        tagRules: sale.tagRules,
        schedule: sale.schedule,
        configuration: sale.configuration,
        addTagsEnabled: sale.addTagsEnabled,
        removeTagsEnabled: sale.removeTagsEnabled,
        trackConditionChanges: sale.trackConditionChanges,
        autoReapplyChanges: sale.autoReapplyChanges,
        autoReapplyIntervalUnit: sale.autoReapplyIntervalUnit,
        autoReapplyIntervalValue: sale.autoReapplyIntervalValue,
      },
    });

    return redirect(`${EDIT_SALE_URL}?id=${copy.id}`);
  }

  return json({ ok: false, message: "Invalid action." }, { status: 400 });
};

function humanize(value) {
  return String(value || "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/\b\w/g, (char) => char.toUpperCase()) || "-";
}

function formatDate(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatChange(change, label, currencyCode) {
  const action = String(change?.action || "").toLowerCase();
  if (!action) return "";
  if (action === "reset_compare_at_price") return "Reset compare at price";
  if (action === "set_to_price") return "Set compare at price to price";
  if (action === "set_new_value") {
    return change.amount
      ? `Set ${label} to ${change.amount}${currencyCode ? ` ${currencyCode}` : ""}`
      : `Set ${label}`;
  }

  const actionLabel =
    action === "increase" ? "Increase" : action === "decrease" ? "Decrease" : humanize(action);
  const value =
    change.type === "by_amount"
      ? `${change.amount || ""}${currencyCode ? ` ${currencyCode}` : ""}`
      : change.percent
        ? `${change.percent}%`
        : change.amount;

  return `${actionLabel} ${label}${value ? ` by ${value}` : ""}`;
}

function getSaleChanges(sale, currencyCode) {
  return [
    formatChange(sale.priceChange, "price", currencyCode),
    formatChange(sale.compareAtPriceChange, "compare at price", currencyCode),
  ].filter(Boolean);
}

function getResourceTitle(item) {
  return item?.title || item?.name || item?.label || "";
}

function getResourceTitles(items = []) {
  return items.map(getResourceTitle).filter(Boolean);
}

function getMarketLabel(market) {
  if (!market) return "";

  const currencyCode =
    market.currencyCode ||
    market.currencySettings?.baseCurrency?.currencyCode ||
    "";
  return `${market.name || market.label || "Market"}${currencyCode ? ` (${currencyCode})` : ""}`;
}

function getSaleMarkets(sale) {
  return Array.isArray(sale.markets) ? sale.markets : [];
}

function getSaleMarketCurrencyCodes(sale) {
  const currencies = [
    ...new Set(
      getSaleMarkets(sale)
        .flatMap((market) => [
          market.currencyCode,
          market.currencySettings?.baseCurrency?.currencyCode,
          ...(Array.isArray(market.priceLists)
            ? market.priceLists.map((priceList) => priceList.currencyCode)
            : []),
        ])
        .filter(Boolean),
    ),
  ];

  return currencies;
}

function getSaleMarketCurrencyLabel(sale) {
  return getSaleMarketCurrencyCodes(sale).join(" / ");
}

function getSaleCurrencyCode(sale, shopCurrency = "") {
  return String(sale.changeType || "").toLowerCase() === "markets"
    ? getSaleMarketCurrencyLabel(sale)
    : shopCurrency;
}

function getTagRuleTitles(sale, key) {
  return getResourceTitles(sale.tagRules?.[key] || []);
}

function formatScope(scope) {
  const normalized = String(scope || "").toLowerCase().trim();

  if (normalized === "whole_store") return "Whole store";
  if (normalized === "nothing") return "Nothing";
  if (normalized === "selected_collections") return "Selected collections";
  if (normalized === "selected_products") return "Selected products";
  if (normalized === "selected_products_with_variants") return "Selected products with variants";
  if (normalized === "selected_tags") return "Selected tags";

  return humanize(scope);
}

function getScopeItems(scope, resources = {}) {
  const normalized = String(scope || "").toLowerCase().trim();

  if (normalized === "selected_collections") return resources.collections || [];
  if (normalized === "selected_products") return resources.products || [];
  if (normalized === "selected_products_with_variants") return resources.variants || [];
  if (normalized === "selected_tags") return resources.tags || [];
  return [];
}

function formatDiscountedScope(sale) {
  const scope = String(sale.discountedScope || "").toLowerCase().trim();
  if (!scope || scope === "nothing") return "Nothing";
  if (scope === "products_on_sale") return "Products on sale";
  if (scope === "product_types_on_sale" || scope === "variants_on_sale") {
    return "Product variants on sale";
  }
  return humanize(scope);
}

function formatSchedule(sale) {
  const lines = [];
  if (sale.startAt) lines.push(`From ${formatDate(sale.startAt)}`);
  if (sale.endAt) lines.push(`Until ${formatDate(sale.endAt)}`);
  return lines.length ? lines : ["Not scheduled"];
}

function FieldBadges({ items }) {
  if (!items.length) {
    return (
      <Text as="span" tone="subdued">
        -
      </Text>
    );
  }

  return (
    <InlineStack gap="150" wrap>
      {items.map((item) => (
        <Badge key={item}>{item}</Badge>
      ))}
    </InlineStack>
  );
}

function ReapplyIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M1.5 7.25a.75.75 0 0 0 1.5 0 3 3 0 0 1 3-3h6.566l-1.123 1.248a.75.75 0 1 0 1.115 1.004l2.25-2.5a.75.75 0 0 0-.028-1.032l-2.25-2.25a.749.749 0 1 0-1.06 1.06l.97.97h-6.44a4.5 4.5 0 0 0-4.5 4.5" />
      <path d="M14.5 8.75a.75.75 0 0 0-1.5 0 3 3 0 0 1-3 3h-6.566l1.123-1.248a.75.75 0 1 0-1.115-1.004l-2.25 2.5a.75.75 0 0 0 .028 1.032l2.25 2.25a.749.749 0 1 0 1.06-1.06l-.97-.97h6.44a4.5 4.5 0 0 0 4.5-4.5" />
    </svg>
  );
}

function TrackingIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><path d="M7.377.5c-.926 0-1.676.75-1.676 1.676v.688c0 .056-.043.17-.198.251q-.23.12-.448.262c-.147.097-.268.076-.318.048l-.6-.346a1.676 1.676 0 0 0-2.29.613l-.622 1.08a1.675 1.675 0 0 0 .613 2.289l.648.374c.048.028.124.12.119.29l-.003.177q0 .144.008.288c.009.175-.07.27-.119.299l-.653.377a1.676 1.676 0 0 0-.613 2.29l.623 1.08a1.68 1.68 0 0 0 2.29.613l.7-.405c.048-.028.166-.048.312.043q.173.107.353.202c.155.08.198.195.198.251v.811c0 .926.75 1.676 1.676 1.676h1.246c.926 0 1.676-.75 1.676-1.676v-.81a.75.75 0 1 0-1.5 0v.81a.176.176 0 0 1-.176.176h-1.246a.176.176 0 0 1-.176-.176v-.81c0-.73-.462-1.3-1.003-1.582a4 4 0 0 1-.255-.146c-.514-.32-1.23-.428-1.855-.068l-.7.405a.177.177 0 0 1-.241-.065l-.623-1.08a.175.175 0 0 1 .064-.24l.653-.377c.637-.368.899-1.062.867-1.677a4 4 0 0 1-.006-.21q0-.064.002-.127c.02-.604-.245-1.278-.868-1.638l-.648-.374a.175.175 0 0 1-.064-.24l.623-1.08a.175.175 0 0 1 .24-.064l.6.346c.638.368 1.37.247 1.888-.09a4 4 0 0 1 .323-.19c.54-.282 1.003-.852 1.003-1.58v-.688c0-.097.078-.176.176-.176h1.246c.097 0 .176.079.176.176v.688c0 .728.462 1.298 1.003 1.58q.166.087.323.19c.517.337 1.25.458 1.888.09l.6-.346a.175.175 0 0 1 .24.064l.623 1.08a.175.175 0 0 1-.064.24l-.648.374c-.623.36-.888 1.034-.868 1.638l.002.128c0 .082-.002.247-.006.309a.75.75 0 0 0 1.498.078 9 9 0 0 0 .005-.563c-.005-.171.07-.263.12-.291l.647-.374a1.677 1.677 0 0 0 .613-2.29l-.623-1.079a1.676 1.676 0 0 0-2.29-.613l-.6.346c-.049.028-.17.048-.318-.048a5 5 0 0 0-.448-.262c-.155-.081-.197-.195-.197-.251v-.688c0-.926-.75-1.676-1.676-1.676z"></path><path fill-rule="evenodd" d="M8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6m0-1.5a1.5 1.5 0 1 0-.001-3.001 1.5 1.5 0 0 0 .001 3.001"></path><path d="M12.035 9.839a.501.501 0 0 0-.785.411v4.5a.5.5 0 0 0 .785.411l3.25-2.25a.5.5 0 0 0 0-.822z"></path></svg>
  );
}

function getSaleLogs(sale) {
  return sale.executionSummary?.logs || [];
}

function mergeLogStatus(currentStatus, nextStatus) {
  const statuses = [currentStatus, nextStatus].map((status) =>
    String(status || "").toLowerCase(),
  );

  if (statuses.some((status) => status.includes("cancel"))) {
    return "Canceled";
  }

  if (statuses.some((status) => status.includes("fail") || status.includes("error"))) {
    return "Failed";
  }

  if (statuses.some((status) => status.includes("skip"))) {
    return "Skipped";
  }

  if (statuses.some((status) => status.includes("applied") || status.includes("updated"))) {
    return "Applied";
  }

  return currentStatus || nextStatus || "Applied";
}

function isCanceledSaleStatus(status) {
  const normalized = normalizeSaleStatus(status);
  return normalized === SALE_STATUS.CANCELED || String(status || "").toLowerCase().includes("cancelled");
}

function getSaleLogStatusDisplay(sale, log) {
  const status = log?.status || sale?.status || "";
  const normalizedStatus = String(status || "").toLowerCase();

  if (isCanceledSaleStatus(sale?.status) || isCanceledSaleStatus(status)) {
    return { label: "Canceled", tone: "critical" };
  }

  if (normalizedStatus.includes("fail") || normalizedStatus.includes("error")) {
    return { label: "Failed", tone: "critical" };
  }

  if (normalizedStatus.includes("skip")) {
    return { label: "Skipped", tone: "attention" };
  }

  if (normalizedStatus.includes("schedule")) {
    return { label: "Schedule", tone: "info" };
  }

  if (normalizedStatus.includes("applied") || normalizedStatus.includes("updated")) {
    return { label: "Applied", tone: "success" };
  }

  const display = getSaleStatusDisplay({ ...sale, status });
  return {
    label: display.label || "Applied",
    tone: display.tone === "subdued" ? "success" : display.tone,
  };
}

function getVisibleSaleLogs(sale) {
  const logs = getSaleLogs(sale);
  if (saleUsesVariantLogLinks(sale)) {
    return logs;
  }

  const groupedLogs = new Map();

  for (const log of logs) {
    const key = log.productId || log.productTitle || log.id || log.variantId;
    if (!key) continue;

    const existingLog = groupedLogs.get(key);
    if (!existingLog) {
      groupedLogs.set(key, {
        ...log,
        id: `product-${key}`,
        variantId: "",
        variantTitle: "",
        changes: Array.from(new Set(log.changes || [])),
        status: log.status || "Applied",
      });
      continue;
    }

    existingLog.changes = Array.from(
      new Set([...(existingLog.changes || []), ...(log.changes || [])]),
    );
    existingLog.status = mergeLogStatus(existingLog.status, log.status);
  }

  return Array.from(groupedLogs.values());
}

function getSaleAppliedAt(sale) {
  return (
    sale.executionSummary?.processingCompletedAt ||
    sale.executionSummary?.completedAt ||
    sale.completedAt ||
    sale.startedAt ||
    sale.createdAt ||
    ""
  );
}

function getSaleProductDetails(sale, productId, shop) {
  const selectedProductId = getShopifyNumericId(productId);
  if (!selectedProductId) return null;

  const productLogs = getSaleLogs(sale).filter(
    (log) => getShopifyNumericId(log.productId) === selectedProductId,
  );

  if (!productLogs.length) return null;

  const firstLog = productLogs[0];

  return {
    productId: firstLog.productId,
    productTitle: firstLog.productTitle || "Product",
    adminUrl: getAdminProductUrl(shop, firstLog.productId),
    appliedAt: getSaleAppliedAt(sale),
    status: mergeLogStatus("", productLogs.map((log) => log.status).join(" ")),
    variants: productLogs.map((log, index) => ({
      rowId: log.variantId || `${firstLog.productId}-${index}`,
      variantId: log.variantId,
      title: log.variantTitle || "Default Title",
      sku: log.variantSku || log.sku || "-",
      changes: log.changes?.length ? log.changes : ["No changes recorded"],
      adminUrl: getAdminVariantUrl(shop, log.productId, log.variantId),
      status: log.status || "Applied",
    })),
  };
}

function getVisibleChangeLines(changes = [], limit = 2) {
  const visible = changes.slice(0, limit);
  const hiddenCount = Math.max(changes.length - visible.length, 0);

  return hiddenCount ? [...visible, `and ${hiddenCount} more`] : visible;
}

function getShopifyNumericId(id) {
  const match = String(id || "").match(/(\d+)$/);
  return match ? match[1] : "";
}

function getAdminProductUrl(shop, productId) {
  const numericId = getShopifyNumericId(productId);
  if (!numericId) return "";
  return `https://${shop}/admin/products/${numericId}`;
}

function getAdminCollectionUrl(shop, collectionId) {
  const numericId = getShopifyNumericId(collectionId);
  if (!numericId) return "";
  return `https://${shop}/admin/collections/${numericId}`;
}

function getAdminVariantUrl(shop, productId, variantId) {
  const productNumericId = getShopifyNumericId(productId);
  const variantNumericId = getShopifyNumericId(variantId);
  if (!productNumericId || !variantNumericId) return "";
  return `https://${shop}/admin/products/${productNumericId}/variants/${variantNumericId}`;
}

function saleUsesVariantLogLinks(sale) {
  return [sale.applyScope, sale.excludeScope]
    .map((scope) => String(scope || "").toLowerCase())
    .includes("selected_products_with_variants");
}

function getLogResourceUrl(shop, log, useVariantLogLinks) {
  if (useVariantLogLinks && log.variantId) {
    return (
      getAdminVariantUrl(shop, log.productId, log.variantId) ||
      getAdminProductUrl(shop, log.productId)
    );
  }

  return getAdminProductUrl(shop, log.productId);
}

function getLogResourceTitle(log, useVariantLogLinks) {
  if (useVariantLogLinks && log.variantTitle) {
    return log.variantTitle;
  }

  return log.productTitle || "Product";
}

function getScopeResourceUrl(shop, scope, item) {
  const normalized = String(scope || "").toLowerCase().trim();

  if (normalized === "selected_collections") return getAdminCollectionUrl(shop, item.id);
  if (normalized === "selected_products") return getAdminProductUrl(shop, item.id);
  if (normalized === "selected_products_with_variants") {
    return (
      getAdminVariantUrl(shop, item.productId, item.id) ||
      getAdminProductUrl(shop, item.productId)
    );
  }

  return "";
}

function ResourceThumb({ item }) {
  const title = getResourceTitle(item);
  const first = title.charAt(0).toUpperCase() || "?";

  return (
    <span
      style={{
        alignItems: "center",
        background: "#F6F6F7",
        border: "1px solid #E1E3E5",
        borderRadius: 8,
        color: "#6D7175",
        display: "inline-flex",
        flexShrink: 0,
        fontSize: 12,
        fontWeight: 600,
        height: 40,
        justifyContent: "center",
        overflow: "hidden",
        width: 40,
      }}
    >
      {item?.imageUrl ? (
        <img
          src={item.imageUrl}
          alt={item.imageAlt || title}
          style={{ display: "block", height: "100%", objectFit: "cover", width: "100%" }}
        />
      ) : (
        first
      )}
    </span>
  );
}

function ScopeResourceList({ sale, scope, resources }) {
  const items = getScopeItems(scope, resources);

  if (!items.length) return null;

  return (
    <BlockStack gap="250">
      {items.map((item) => {
        const title = getResourceTitle(item) || "Resource";
        const url = getScopeResourceUrl(sale.shop, scope, item);

        return (
          <InlineStack key={item.id || title} gap="300" blockAlign="center" wrap={false}>
            <ResourceThumb item={item} />
            <BlockStack gap="050">
              {url ? (
                <a href={url} target="_blank" rel="noopener noreferrer">
                  {title}
                </a>
              ) : (
                <Text as="span">{title}</Text>
              )}
              {item.productTitle ? (
                <Text as="span" tone="subdued" variant="bodySm">
                  {item.productTitle}
                </Text>
              ) : null}
            </BlockStack>
          </InlineStack>
        );
      })}
    </BlockStack>
  );
}

function DetailRow({ label, value, children }) {
  return (
    <Box paddingBlock="400" borderBlockEndWidth="025" borderColor="border">
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(160px, 200px) minmax(0, 1fr)",
          gap: 24,
          alignItems: "start",
        }}
      >
        <Text as="dt" fontWeight="semibold">
          {label}
        </Text>
        <Box>
          {children || (
            <Text as="dd" fontWeight="semibold">
              {value || "-"}
            </Text>
          )}
        </Box>
      </div>
    </Box>
  );
}

export default function SaleDetailsPage() {
  const params = useParams();
  return isNewSaleRoute(params) ? <NewSalePage /> : <SaleDetailsContent />;
}

function CompactSpinner({ label }) {
  return (
    <span style={{ display: "inline-flex", transform: "scale(0.75)", transformOrigin: "center" }}>
      <Spinner size="small" accessibilityLabel={label} />
    </span>
  );
}

function SaleProductDetailsView({ productDetails, backUrl }) {
  const statusLabel = productDetails?.status || "Applied";

  return (
    <Page
      title="Price change details"
      titleMetadata={<Badge tone="success">{statusLabel}</Badge>}
      backAction={{
        content: "Sale details",
        url: backUrl,
      }}
    >
      <TitleBar title="Price change details" />

      <Layout>
        <Layout.Section>
          <BlockStack gap="400">
            <Card>
              <DetailRow label="Product">
                {productDetails?.adminUrl ? (
                  <a
                    href={productDetails.adminUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    {productDetails.productTitle}
                  </a>
                ) : (
                  <Text as="p">{productDetails?.productTitle || "-"}</Text>
                )}
              </DetailRow>

              <DetailRow label="Applied" value={formatDate(productDetails?.appliedAt)} />
            </Card>

            <Card padding="0">
              <Box padding="400">
                <Text as="h2" variant="headingMd">
                  Variants
                </Text>
              </Box>

              <IndexTable
                resourceName={{ singular: "variant", plural: "variants" }}
                itemCount={productDetails?.variants?.length || 0}
                selectable={false}
                headings={[
                  { title: "Title" },
                  { title: "SKU" },
                  { title: "Changes" },
                ]}
              >
                {(productDetails?.variants || []).map((variant, index) => (
                  <IndexTable.Row
                    id={`${variant.rowId || index}`}
                    key={`${variant.rowId || index}`}
                    position={index}
                  >
                    <IndexTable.Cell>
                      {variant.adminUrl ? (
                        <a
                          href={variant.adminUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          {variant.title}
                        </a>
                      ) : (
                        <Text as="span">{variant.title}</Text>
                      )}
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <Text as="span">{variant.sku || "-"}</Text>
                    </IndexTable.Cell>
                    <IndexTable.Cell>
                      <BlockStack gap="100">
                        {(variant.changes || []).map((change) => (
                          <Text as="span" key={change}>
                            {change}
                          </Text>
                        ))}
                      </BlockStack>
                    </IndexTable.Cell>
                  </IndexTable.Row>
                ))}
              </IndexTable>
            </Card>
          </BlockStack>
        </Layout.Section>
      </Layout>
    </Page>
  );
}

function SaleDetailsContent() {
  const {
    sale,
    shop,
    shopCurrency,
    toastMessage,
  } = useLoaderData();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const actionFetcher = useFetcher();
  const revalidator = useRevalidator();
  const [toast, setToast] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [currentPage, setCurrentPage] = useState(1);
  const [rollbackConfirmOpen, setRollbackConfirmOpen] = useState(false);
  const [optimisticRollbackStartedAt, setOptimisticRollbackStartedAt] = useState("");
  const selectedProductId = getShopifyNumericId(searchParams.get("productId"));
  const productDetails = useMemo(
    () => getSaleProductDetails(sale, selectedProductId, shop),
    [sale, selectedProductId, shop],
  );

  useEffect(() => {
    if (toastMessage) {
      setToast(toastMessage);
    }
  }, [toastMessage]);

  useEffect(() => {
    if (actionFetcher.data?.message) {
      setToast(actionFetcher.data.message);
    }
    if (actionFetcher.data?.ok) {
      revalidator.revalidate();
    }
  }, [actionFetcher.data, revalidator]);

  const logs = useMemo(() => getVisibleSaleLogs(sale), [sale]);
  const filteredLogs = useMemo(() => {
    const normalizedQuery = searchQuery.trim().toLowerCase();
    if (!normalizedQuery) return logs;

    return logs.filter((log) =>
      [log.productTitle, log.variantTitle, ...(log.changes || [])]
        .join(" ")
        .toLowerCase()
        .includes(normalizedQuery),
    );
  }, [logs, searchQuery]);
  const totalPages = Math.max(1, Math.ceil(filteredLogs.length / LOGS_PER_PAGE));
  const safeCurrentPage = Math.min(currentPage, totalPages);
  const paginatedLogs = filteredLogs.slice(
    (safeCurrentPage - 1) * LOGS_PER_PAGE,
    safeCurrentPage * LOGS_PER_PAGE,
  );
  const isSubmitting = actionFetcher.state !== "idle";
  const isRollbackSubmitting =
    actionFetcher.state !== "idle" &&
    String(actionFetcher.formData?.get("intent") || "") === "rollback_sale";
  const visibleSale = isRollbackSubmitting
    ? {
        ...sale,
        status: SALE_STATUS.CANCELING,
        executionSummary: {
          ...(sale.executionSummary || {}),
          status: "Canceling",
          progress: 0,
          rollbackStartedAt: optimisticRollbackStartedAt || new Date().toISOString(),
        },
      }
    : sale;
  const statusDisplay = getSaleStatusDisplay(visibleSale);
  const normalizedStatus = normalizeSaleStatus(visibleSale.status);
  const isCompletedSale = normalizedStatus === SALE_STATUS.COMPLETED;
  const isBusySale = [
    SALE_STATUS.PENDING,
    SALE_STATUS.APPLYING,
    SALE_STATUS.CANCELING,
    SALE_STATUS.CHECKING_CHANGES,
  ].includes(normalizedStatus);
  const saleMarkets = getSaleMarkets(sale);
  const isMarketSale = String(sale.changeType || "").toLowerCase() === "markets";
  const saleCurrencyCode = getSaleCurrencyCode(sale, shopCurrency);
  const useVariantLogLinks = saleUsesVariantLogLinks(sale);
  const tagsToAdd = getTagRuleTitles(sale, "add");
  const tagsToRemove = getTagRuleTitles(sale, "remove");
  const showExcludeDiscounted =
    String(sale.discountedScope || "").toLowerCase().trim() !== "nothing";

  useEffect(() => {
    if (
      ![
        SALE_STATUS.PENDING,
        SALE_STATUS.APPLYING,
        SALE_STATUS.SCHEDULED,
        SALE_STATUS.CANCELING,
        SALE_STATUS.CHECKING_CHANGES,
      ].includes(normalizedStatus)
    ) {
      return undefined;
    }

    const interval = setInterval(() => revalidator.revalidate(), 1000);
    return () => clearInterval(interval);
  }, [revalidator, normalizedStatus]);

  useEffect(() => {
    setCurrentPage(1);
  }, [searchQuery]);

  const submitAction = (intent) => {
    const formData = new FormData();
    formData.set("intent", intent);
    actionFetcher.submit(formData, { method: "post" });
  };

  if (selectedProductId) {
    return (
      <SaleProductDetailsView
        productDetails={productDetails}
        backUrl={withShopifyEmbeddedParams(`/app/sales/${sale.id}`, location.search)}
      />
    );
  }

  return (
    <>
      <TitleBar title="Boltr Bulk Price Editor" />

      <Page
        title={sale.title}
        backAction={{
          content: "Sales",
          url: withShopifyEmbeddedParams("/app/sales", location.search),
        }}
        primaryAction={{
          content: "Edit sale",
          disabled: isBusySale,
          onAction: () => navigate(`${EDIT_SALE_URL}?id=${sale.id}`),
        }}
        actionGroups={[
          {
            title: "Actions",
            actions: [
              {
                content: "Check changes",
                disabled: isSubmitting || !isCompletedSale,
                onAction: () => submitAction("check_changes"),
              },
              {
                content: "Disable",
                destructive: true,
                disabled: isSubmitting || !canRollbackSale(sale),
                onAction: () => setRollbackConfirmOpen(true),
              },
              {
                content: "Duplicate",
                disabled: isSubmitting,
                onAction: () => submitAction("duplicate_sale"),
              },
            ],
          },
        ]}
      >
        {isRollbackSubmitting ? (
          <div style={pageOperationOverlayStyle}>
            <div style={pageOperationSpinnerStyle}>
              <Spinner accessibilityLabel="Disabling sale" size="large" />
            </div>
          </div>
        ) : null}
        <Layout>
          <Layout.Section>
            <BlockStack gap="400">
              {actionFetcher.data?.message && actionFetcher.data?.ok === false ? (
                <Banner tone="critical">{actionFetcher.data.message}</Banner>
              ) : null}

              <Card>
                <DetailRow label="Changes">
                  <BlockStack gap="300">
                    {getSaleChanges(sale, saleCurrencyCode).map((change) => (
                      <Text as="p" key={change}>
                        {change}
                      </Text>
                    ))}

                    {sale.autoReapplyChanges ? (
                      <InlineStack gap="150" blockAlign="center" wrap={false}>
                        <ReapplyIcon />
                        <Text as="p" tone="subdued">
                          Automatically re-apply price changes - {formatAutoReapplyInterval(sale)}
                        </Text>
                      </InlineStack>
                    ) : null}

                  </BlockStack>
                </DetailRow>

                <DetailRow label="Change type">
                  <BlockStack gap="100">
                    <Text as="p" fontWeight="semibold">
                      {humanize(sale.changeType || "products")}
                    </Text>
                    {sale.changeType === "markets" && saleMarkets.length ? (
                      <BlockStack gap="050">
                        {saleMarkets.map((market) => (
                          <Text as="p" key={market.id || market.name}>
                            - {getMarketLabel(market)}
                          </Text>
                        ))}
                      </BlockStack>
                    ) : null}
                    {sale.changeType === "markets" && sale.applyToFixedPrices ? (
                      <Text as="p" tone="subdued">
                        Applies only to fixed market prices.
                      </Text>
                    ) : null}
                  </BlockStack>
                </DetailRow>

                <DetailRow label="Apply to">
                  <BlockStack gap="300">
                    <Text as="p" fontWeight="semibold">
                      {formatScope(sale.applyScope)}
                    </Text>
                    <ScopeResourceList
                      sale={sale}
                      scope={sale.applyScope}
                      resources={sale.applyResources || {}}
                    />
                    {sale.trackConditionChanges ? (
                      <InlineStack gap="150" blockAlign="center" wrap={false}>
                        <TrackingIcon />
                        <Text as="p" tone="subdued">
                          Tracking changes in condition automatically (every hour)
                        </Text>
                      </InlineStack>
                    ) : null}
                  </BlockStack>
                </DetailRow>

                <DetailRow label="Exclude">
                  <BlockStack gap="300">
                    <Text as="p" fontWeight="semibold">
                      {formatScope(sale.excludeScope)}
                    </Text>
                    <ScopeResourceList
                      sale={sale}
                      scope={sale.excludeScope}
                      resources={sale.excludeResources || {}}
                    />
                  </BlockStack>
                </DetailRow>

                {showExcludeDiscounted ? (
                  <DetailRow label="Exclude discounted" value={formatDiscountedScope(sale)} />
                ) : null}

                <DetailRow label="Schedule">
                  <BlockStack gap="100">
                    {formatSchedule(sale).map((line) => (
                      <Text as="p" key={line}>
                        {line}
                      </Text>
                    ))}
                  </BlockStack>
                </DetailRow>

                <DetailRow label="Status">
                  <BlockStack gap="150">
                    <InlineStack gap="200" blockAlign="center" wrap={false}>
                      <Badge tone={statusDisplay.tone}>
                        <InlineStack gap="100" blockAlign="center" wrap={false}>
                          {statusDisplay.showSpinner && !isRollbackSubmitting ? (
                            <CompactSpinner label={`${statusDisplay.label} sale`} />
                          ) : null}
                          <span>{statusDisplay.label}</span>
                          {statusDisplay.showProgress ? (
                            <span>{statusDisplay.progress}%</span>
                          ) : null}
                        </InlineStack>
                      </Badge>
                    </InlineStack>
                  </BlockStack>
                </DetailRow>

                {isMarketSale && saleMarkets.length ? (
                  <DetailRow label="Markets">
                    <FieldBadges items={saleMarkets.map(getMarketLabel).filter(Boolean)} />
                  </DetailRow>
                ) : null}

                <DetailRow label="Created at" value={formatDate(sale.createdAt)} />
                <DetailRow label="Started at" value={formatDate(sale.startedAt)} />

                {sale.addTagsEnabled && tagsToAdd.length ? (
                  <DetailRow label="Add tags">
                    <FieldBadges items={tagsToAdd} />
                  </DetailRow>
                ) : null}

                {sale.removeTagsEnabled && tagsToRemove.length ? (
                  <DetailRow label="Remove tags">
                    <FieldBadges items={tagsToRemove} />
                  </DetailRow>
                ) : null}
              </Card>

              <Card>
                <BlockStack gap="300">
                  <Text as="h2" variant="headingMd">
                    Logs
                  </Text>

                  <TextField
                    label="Product name"
                    labelHidden
                    value={searchQuery}
                    onChange={setSearchQuery}
                    placeholder="Product name"
                    clearButton
                    onClearButtonClick={() => setSearchQuery("")}
                    autoComplete="off"
                  />

                  <IndexTable
                    resourceName={{ singular: "log", plural: "logs" }}
                    itemCount={paginatedLogs.length}
                    selectable={false}
                    headings={[
                      { title: "Product" },
                      { title: "Changes" },
                      { title: "Status" },
                      { title: "" },
                    ]}
                  >
                    {paginatedLogs.map((log, index) => {
                      const resourceUrl = getLogResourceUrl(shop, log, useVariantLogLinks);
                      const resourceTitle = getLogResourceTitle(log, useVariantLogLinks);
                      const logStatusDisplay = getSaleLogStatusDisplay(visibleSale, log);
                      const rowId = useVariantLogLinks
                        ? log.variantId || log.id || index
                        : log.productId || log.productTitle || log.id || index;

                      return (
                        <IndexTable.Row
                          id={`${rowId}`}
                          key={`${rowId}`}
                          position={index}
                        >
                          <IndexTable.Cell>
                            {resourceUrl ? (
                              <a
                                href={resourceUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                              >
                                {resourceTitle}
                              </a>
                            ) : (
                              <Text as="span">{resourceTitle}</Text>
                            )}
                          </IndexTable.Cell>
                        <IndexTable.Cell>
                          <BlockStack gap="100">
                            {getVisibleChangeLines(log.changes || []).map((change) => (
                              <Text as="span" key={change}>
                                {change}
                              </Text>
                            ))}
                          </BlockStack>
                        </IndexTable.Cell>
                        <IndexTable.Cell>
                          <Badge tone={logStatusDisplay.tone}>{logStatusDisplay.label}</Badge>
                        </IndexTable.Cell>
                        <IndexTable.Cell>
                          <Button
                            size="slim"
                            disabled={!log.productId}
                            url={
                              log.productId
                                ? `/app/sales/${sale.id}?productId=${getShopifyNumericId(log.productId)}`
                                : undefined
                            }
                          >
                            Details
                          </Button>
                        </IndexTable.Cell>
                      </IndexTable.Row>
                      );
                    })}
                  </IndexTable>

                  {!filteredLogs.length ? (
                    <Box padding="400">
                      <Text as="p" tone="subdued">
                        {searchQuery
                          ? "No logs found for your search."
                          : "No product changes were recorded for this sale."}
                      </Text>
                    </Box>
                  ) : null}

                  {filteredLogs.length > LOGS_PER_PAGE ? (
                    <InlineStack align="center">
                      <Pagination
                        hasPrevious={safeCurrentPage > 1}
                        onPrevious={() =>
                          setCurrentPage((page) => Math.max(1, page - 1))
                        }
                        hasNext={safeCurrentPage < totalPages}
                        onNext={() =>
                          setCurrentPage((page) => Math.min(totalPages, page + 1))
                        }
                      />
                    </InlineStack>
                  ) : null}
                </BlockStack>
              </Card>
            </BlockStack>
          </Layout.Section>
        </Layout>
      </Page>

      <Modal
        open={rollbackConfirmOpen}
        onClose={() => setRollbackConfirmOpen(false)}
        title="Disable sale?"
        size="small"
        primaryAction={{
          content: "Disable",
          loading: isRollbackSubmitting,
          onAction: () => {
            setOptimisticRollbackStartedAt(new Date().toISOString());
            setRollbackConfirmOpen(false);
            submitAction("rollback_sale");
          },
        }}
        secondaryActions={[
          {
            content: "Close",
            onAction: () => setRollbackConfirmOpen(false),
          },
        ]}
      >
        <Modal.Section>
          <p style={confirmationModalContentStyle}>
            The sale will be stopped and prices return to old values. Do you want
            to continue?
          </p>
        </Modal.Section>
      </Modal>

      {toast ? <Toast content={toast} onDismiss={() => setToast("")} /> : null}
    </>
  );
}
