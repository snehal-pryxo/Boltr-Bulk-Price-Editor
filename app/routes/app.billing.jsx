import { json } from "@remix-run/node";
import { Form, useLoaderData, useNavigation, useSearchParams } from "@remix-run/react";
import { TitleBar } from "@shopify/app-bridge-react";
import {
  Badge,
  BlockStack,
  Box,
  Button,
  ButtonGroup,
  Card,
  Divider,
  InlineStack,
  Layout,
  Page,
  Text,
} from "@shopify/polaris";
import { authenticate } from "../shopify.server";
import { ALL_PRICING_PLAN_KEYS, PLAN_TIERS } from "../lib/pricing-plans";

export async function loader({ request }) {
  const { billing } = await authenticate.admin(request);
  const billingTestMode = isBillingTestMode();
  const billingCheck = await billing.check({
    plans: ALL_PRICING_PLAN_KEYS,
    isTest: billingTestMode,
  });
  const activeSubscription = billingCheck.appSubscriptions?.[0] || null;

  return json({
    activePlan: activeSubscription?.name || "",
    billingTestMode,
    hasActivePayment: Boolean(billingCheck.hasActivePayment),
  });
}

export async function action({ request }) {
  const { billing, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const plan = String(formData.get("plan") || "");

  if (!ALL_PRICING_PLAN_KEYS.includes(plan)) {
    return json({ ok: false, message: "Invalid plan selected." }, { status: 400 });
  }

  const returnUrl = getBillingReturnUrl(session.shop);

  return billing.request({
    plan,
    isTest: isBillingTestMode(),
    returnUrl,
  });
}

function isBillingTestMode() {
  if (process.env.SHOPIFY_BILLING_TEST) {
    return process.env.SHOPIFY_BILLING_TEST !== "false";
  }

  return true;
}

function getBillingReturnUrl(shop) {
  const storeHandle = String(shop || "").replace(".myshopify.com", "");
  const appHandle = process.env.SHOPIFY_APP_HANDLE || "bulk-price-editor-boltr";

  if (storeHandle && appHandle) {
    return `https://admin.shopify.com/store/${storeHandle}/apps/${appHandle}/app/`;
  }

  return new URL("/app", process.env.SHOPIFY_APP_URL || "https://app.local").toString();
}

function getSelectedInterval(searchParams) {
  return searchParams.get("interval") === "yearly" ? "yearly" : "monthly";
}

function PlanCard({ plan, interval, activePlan, hasActivePayment, submittingPlan }) {
  const planKey = interval === "yearly" ? plan.yearlyPlan : plan.monthlyPlan;
  const price = interval === "yearly" ? plan.yearlyPrice : plan.monthlyPrice;
  const intervalLabel = planKey ? (interval === "yearly" ? "/year" : "/month") : "";
  const isCurrent = planKey ? activePlan === planKey : !hasActivePayment;
  const isLoading = submittingPlan === planKey;

  return (
    <Card padding="0">
      <BlockStack gap="0">
        <Box padding="500">
          <BlockStack gap="400">
            <InlineStack align="space-between" blockAlign="center">
              <Text as="h2" variant="headingMd">
                {plan.name}
              </Text>
              {isCurrent ? <Badge tone="success">Current</Badge> : null}
            </InlineStack>

            <InlineStack gap="100" blockAlign="end">
              <Text as="p" variant="headingXl" fontWeight="bold">
                {price}
              </Text>
              {intervalLabel ? (
                <Box paddingBlockEnd="100">
                  <Text as="span">{intervalLabel}</Text>
                </Box>
              ) : null}
            </InlineStack>

            {planKey ? (
              <Form method="post">
                <input type="hidden" name="plan" value={planKey} />
                <Button
                  submit
                  fullWidth
                  variant={isCurrent ? "secondary" : "primary"}
                  disabled={isCurrent || Boolean(submittingPlan)}
                  loading={isLoading}
                >
                  {isCurrent ? "Current plan" : "Choose plan"}
                </Button>
              </Form>
            ) : (
              <Button fullWidth disabled={isCurrent} variant="secondary">
                {isCurrent ? "Current plan" : "Free plan"}
              </Button>
            )}
          </BlockStack>
        </Box>

        <Divider />

        <Box padding="500">
          <BlockStack gap="300">
            <Bullet>Unlimited sales</Bullet>
            <Bullet>Unlimited tasks</Bullet>
            <Bullet>{plan.priceChangeLimit}</Bullet>
          </BlockStack>
        </Box>

        <Divider />

        <Box padding="500">
          <BlockStack gap="300">
            {plan.features.map((feature) => (
              <Check key={feature}>{feature}</Check>
            ))}
          </BlockStack>
        </Box>
      </BlockStack>
    </Card>
  );
}

function Bullet({ children }) {
  return (
    <InlineStack gap="300" blockAlign="start" wrap={false}>
      <Text as="span">*</Text>
      <Text as="span">{children}</Text>
    </InlineStack>
  );
}

function Check({ children }) {
  return (
    <InlineStack gap="300" blockAlign="start" wrap={false}>
      <Text as="span">+</Text>
      <Text as="span">{children}</Text>
    </InlineStack>
  );
}

export default function PricingPage() {
  const { activePlan, billingTestMode, hasActivePayment } = useLoaderData();
  const navigation = useNavigation();
  const [searchParams, setSearchParams] = useSearchParams();
  const interval = getSelectedInterval(searchParams);
  const submittingPlan =
    navigation.state === "submitting"
      ? String(navigation.formData?.get("plan") || "")
      : "";

  const setInterval = (nextInterval) => {
    const next = new URLSearchParams(searchParams);
    next.set("interval", nextInterval);
    setSearchParams(next);
  };

  return (
    <>
      <TitleBar title="Boltr Bulk Price Editor" />
      <Page title="Manage your plan" fullWidth>
        <Layout>
          <Layout.Section>
            <BlockStack gap="600">
              {billingTestMode ? (
                <InlineStack align="center">
                  <Badge tone="attention">Shopify billing test mode</Badge>
                </InlineStack>
              ) : null}

              <InlineStack align="center">
                <ButtonGroup variant="segmented">
                  <Button
                    pressed={interval === "monthly"}
                    onClick={() => setInterval("monthly")}
                  >
                    Monthly
                  </Button>
                  <Button
                    pressed={interval === "yearly"}
                    onClick={() => setInterval("yearly")}
                  >
                    Yearly (2 months free)
                  </Button>
                </ButtonGroup>
              </InlineStack>

              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
                  gap: 20,
                  alignItems: "start",
                }}
              >
                {PLAN_TIERS.map((plan) => (
                  <PlanCard
                    key={plan.id}
                    plan={plan}
                    interval={interval}
                    activePlan={activePlan}
                    hasActivePayment={hasActivePayment}
                    submittingPlan={submittingPlan}
                  />
                ))}
              </div>
            </BlockStack>
          </Layout.Section>
        </Layout>
      </Page>
    </>
  );
}
