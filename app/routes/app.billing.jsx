import { json } from "@remix-run/node";
import {
  Form,
  useActionData,
  useLoaderData,
  useNavigation,
  useSearchParams,
} from "@remix-run/react";
import { TitleBar } from "@shopify/app-bridge-react";
import {
  Badge,
  BlockStack,
  Box,
  Banner,
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
import db from "../db.server";

const FREE_PLAN_NAME = "Free Plan";
const BILLING_PLAN_SETTING_KEY = "billing.plan";

export async function loader({ request }) {
  const { billing, session } = await authenticate.admin(request);
  const url = new URL(request.url);
  const billingTestMode = isBillingTestMode();
  const billingCheck = await billing.check({
    plans: ALL_PRICING_PLAN_KEYS,
    isTest: billingTestMode,
  });
  const activeSubscription = billingCheck.appSubscriptions?.[0] || null;
  const activePlan = activeSubscription?.name || FREE_PLAN_NAME;

  await saveBillingPlan(session.shop, activePlan);

  const billingStatus = getBillingStatus({
    hasBillingReturn: url.searchParams.get("billing_return") === "1",
    hasActivePayment: Boolean(billingCheck.hasActivePayment),
    activePlan,
  });

  return json({
    activePlan,
    billingStatus,
    billingTestMode,
    hasActivePayment: Boolean(billingCheck.hasActivePayment),
  });
}


export async function action({ request }) {
  const { billing, session } = await authenticate.admin(request);
  const formData = await request.formData();
  const plan = String(formData.get("plan") || "");

  if (plan === "free") {
    try {
      const billingCheck = await billing.check({
        plans: ALL_PRICING_PLAN_KEYS,
        isTest: isBillingTestMode(),
      });

      await Promise.all(
        (billingCheck.appSubscriptions || []).map((subscription) =>
          billing.cancel({
            subscriptionId: subscription.id,
            isTest: isBillingTestMode(),
            prorate: true,
          }),
        ),
      );

      await saveBillingPlan(session.shop, FREE_PLAN_NAME);

      return json({
        ok: true,
        message: "Free Plan is active.",
        activePlan: FREE_PLAN_NAME,
      });
    } catch (error) {
      console.error("Unable to activate free billing plan.", {
        shop: session.shop,
        error,
      });

      return json(
        {
          ok: false,
          message:
            "We could not activate the Free Plan. Please try again or contact support.",
        },
        { status: 500 },
      );
    }
  }

  if (!ALL_PRICING_PLAN_KEYS.includes(plan)) {
    return json({ ok: false, message: "Invalid plan selected." }, { status: 400 });
  }

  const returnUrl = getBillingReturnUrl(session.shop);

  try {
    return await billing.request({
      plan,
      isTest: isBillingTestMode(),
      returnUrl,
    });
  } catch (error) {
    if (error instanceof Response) {
      throw error;
    }

    console.error("Unable to create Shopify app subscription.", {
      shop: session.shop,
      plan,
      error,
    });

    return json(
      {
        ok: false,
        message:
          "Shopify could not open the billing approval page. Please try again.",
      },
      { status: 500 },
    );
  }
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
    return `https://admin.shopify.com/store/${storeHandle}/apps/${appHandle}/app/billing?billing_return=1`;
  }

  const returnUrl = new URL(
    "/app/billing",
    process.env.SHOPIFY_APP_URL || "https://app.local",
  );
  returnUrl.searchParams.set("billing_return", "1");
  return returnUrl.toString();
}

function getBillingStatus({ hasBillingReturn, hasActivePayment, activePlan }) {
  if (!hasBillingReturn) {
    return null;
  }

  if (hasActivePayment) {
    return {
      tone: "success",
      message: `${activePlan} is active.`,
    };
  }

  return {
    tone: "warning",
    message:
      "Billing approval was not completed. You can choose a paid plan again when you are ready.",
  };
}

async function saveBillingPlan(shop, plan) {
  if (!shop || !plan) {
    return null;
  }

  return db.priceEditorSetting.upsert({
    where: {
      shop_key: {
        shop,
        key: BILLING_PLAN_SETTING_KEY,
      },
    },
    create: {
      shop,
      key: BILLING_PLAN_SETTING_KEY,
      value: plan,
    },
    update: {
      value: plan,
    },
  });
}

function getSelectedInterval(searchParams) {
  return searchParams.get("interval") === "yearly" ? "yearly" : "monthly";
}

function PlanCard({ plan, interval, activePlan, hasActivePayment, submittingPlan }) {
  const planKey = interval === "yearly" ? plan.yearlyPlan : plan.monthlyPlan;
  const price = interval === "yearly" ? plan.yearlyPrice : plan.monthlyPrice;
  const intervalLabel = planKey ? (interval === "yearly" ? "/year" : "/month") : "";
  const submittedPlanKey = planKey || "free";
  const isCurrent = planKey ? activePlan === planKey : !hasActivePayment;
  const isLoading = submittingPlan === submittedPlanKey;

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
              <Form method="post">
                <input type="hidden" name="plan" value="free" />
                <Button
                  submit
                  fullWidth
                  disabled={isCurrent || Boolean(submittingPlan)}
                  loading={isLoading}
                  variant="secondary"
                >
                  {isCurrent ? "Current plan" : "Free plan"}
                </Button>
              </Form>
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
  const { activePlan, billingStatus, billingTestMode, hasActivePayment } =
    useLoaderData();
  const actionData = useActionData();
  const navigation = useNavigation();
  const [searchParams, setSearchParams] = useSearchParams();
  const interval = getSelectedInterval(searchParams);
  const submittingPlan =
    navigation.state === "submitting"
      ? String(navigation.formData?.get("plan") || "")
      : "";

  const updateBillingInterval = (nextInterval) => {
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
              {billingStatus ? (
                <Banner tone={billingStatus.tone}>
                  <Text as="p">{billingStatus.message}</Text>
                </Banner>
              ) : null}

              {actionData?.message ? (
                <Banner tone={actionData.ok ? "success" : "critical"}>
                  <Text as="p">{actionData.message}</Text>
                </Banner>
              ) : null}

              {billingTestMode ? (
                <InlineStack align="center">
                  <Badge tone="attention">Shopify billing test mode</Badge>
                </InlineStack>
              ) : null}

              <InlineStack align="center">
                <ButtonGroup variant="segmented">
                  <Button
                    pressed={interval === "monthly"}
                    onClick={() => updateBillingInterval("monthly")}
                  >
                    Monthly
                  </Button>
                  <Button
                    pressed={interval === "yearly"}
                    onClick={() => updateBillingInterval("yearly")}
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
