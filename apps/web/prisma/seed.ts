import { PrismaClient } from "../src/generated/prisma";

const prisma = new PrismaClient();

/**
 * Seed 12 curated templates across all 9 categories.
 * System templates have workspaceId = null.
 */
async function main() {
  const templates = [
    // ─── SAAS_ONBOARDING (2) ───
    {
      name: "SaaS Signup Flow",
      description:
        "Walk through a complete SaaS signup process from landing page to dashboard onboarding.",
      category: "SAAS_ONBOARDING" as const,
      storySource: `story "SaaS Signup Flow"
  navigate "https://app.example.com/signup"
  type "#email" "user@example.com"
  type "#password" "SecurePass123!"
  click "button:Sign Up"
  wait for "Welcome to your dashboard"
  click "button:Start Tour"
  wait 2s
  click "button:Next"
  click "button:Next"
  click "button:Get Started"
  assert visible ".dashboard-main"`,
      workspaceId: null,
      forkCount: 0,
    },
    {
      name: "Feature Tour Onboarding",
      description:
        "Guide new users through key product features with a step-by-step walkthrough.",
      category: "SAAS_ONBOARDING" as const,
      storySource: `story "Feature Tour"
  navigate "https://app.example.com/dashboard"
  click "button:Take the Tour"
  wait for ".tooltip-step-1"
  click ".sidebar >> Projects"
  wait 1s
  click "button:Create New Project"
  type "#project-name" "My First Project"
  click "button:Create"
  assert visible ".project-card"
  click "button:Next Step"
  click ".settings-icon"
  assert visible ".settings-panel"`,
      workspaceId: null,
      forkCount: 0,
    },

    // ─── ECOMMERCE_CHECKOUT (1) ───
    {
      name: "E-Commerce Checkout Demo",
      description:
        "Demonstrate adding items to cart and completing a full checkout flow.",
      category: "ECOMMERCE_CHECKOUT" as const,
      storySource: `story "Checkout Flow"
  navigate "https://store.example.com/products"
  click ".product-card:first >> Add to Cart"
  wait for ".cart-badge"
  click ".cart-icon"
  assert visible ".cart-summary"
  click "button:Proceed to Checkout"
  type "#shipping-name" "Jane Doe"
  type "#shipping-address" "123 Main St, San Francisco, CA"
  type "#card-number" "4242424242424242"
  type "#card-expiry" "12/28"
  click "button:Place Order"
  wait for "Order confirmed"
  assert visible ".order-confirmation"`,
      workspaceId: null,
      forkCount: 0,
    },

    // ─── API_WALKTHROUGH (1) ───
    {
      name: "REST API Explorer Demo",
      description:
        "Walk through an API documentation page, executing sample requests and showing responses.",
      category: "API_WALKTHROUGH" as const,
      storySource: `story "API Explorer"
  navigate "https://api.example.com/docs"
  click "section:Authentication"
  click "button:Try it out"
  type "#api-key-input" "sk_test_demo123"
  click "button:Execute"
  wait for ".response-body"
  assert visible "200 OK"
  click "section:Users"
  click "GET /api/users"
  click "button:Try it out"
  click "button:Execute"
  wait for ".response-body"
  assert visible "application/json"`,
      workspaceId: null,
      forkCount: 0,
    },

    // ─── MOBILE_DEMO (1) ───
    {
      name: "Responsive Mobile App Demo",
      description:
        "Showcase a responsive web app in mobile viewport with touch-style interactions.",
      category: "MOBILE_DEMO" as const,
      storySource: `story "Mobile App Demo"
  navigate "https://app.example.com" viewport 375x812
  wait for ".mobile-header"
  click ".hamburger-menu"
  wait for ".mobile-nav"
  click "nav >> Dashboard"
  wait 1s
  scroll down 300
  click ".mobile-card:first"
  assert visible ".detail-view"
  click "button:Share"
  wait for ".share-sheet"
  click "button:Copy Link"
  assert visible "Link copied"`,
      workspaceId: null,
      forkCount: 0,
    },

    // ─── CLI_TOOL (1) ───
    {
      name: "CLI Tool Installation Guide",
      description:
        "Record a terminal session showing CLI tool installation and basic usage.",
      category: "CLI_TOOL" as const,
      storySource: `story "CLI Setup Guide"
  navigate "https://docs.example.com/cli"
  assert visible "Installation"
  click "button:Copy" near "npm install"
  wait 1s
  navigate "https://docs.example.com/cli/quickstart"
  assert visible "Quick Start"
  click "button:Copy" near "example-cli init"
  wait 1s
  click "button:Copy" near "example-cli deploy"
  scroll down 200
  assert visible "Next Steps"`,
      workspaceId: null,
      forkCount: 0,
    },

    // ─── LANDING_PAGE (2) ───
    {
      name: "Landing Page Hero Section",
      description:
        "Showcase a landing page hero with CTA buttons and animated elements.",
      category: "LANDING_PAGE" as const,
      storySource: `story "Landing Page Hero"
  navigate "https://www.example.com"
  wait for ".hero-section"
  wait 2s
  scroll down 100
  click "button:Get Started Free"
  wait for ".signup-modal"
  type "#email" "demo@example.com"
  click "button:Start Free Trial"
  assert visible "Check your email"`,
      workspaceId: null,
      forkCount: 0,
    },
    {
      name: "Pricing Page Walkthrough",
      description:
        "Navigate a pricing page comparing plans and toggling billing periods.",
      category: "LANDING_PAGE" as const,
      storySource: `story "Pricing Page"
  navigate "https://www.example.com/pricing"
  wait for ".pricing-grid"
  click "toggle:Annual"
  wait 1s
  assert visible "Save 20%"
  click ".plan-card:Pro >> Select Plan"
  wait for ".checkout-form"
  assert visible "Pro Plan - Annual"
  scroll down 200
  assert visible "FAQ"
  click "FAQ >> What's included?"
  assert visible "All features included"`,
      workspaceId: null,
      forkCount: 0,
    },

    // ─── FEATURE_ANNOUNCEMENT (1) ───
    {
      name: "New Feature Walkthrough",
      description:
        "Demonstrate a newly shipped feature with before/after comparison.",
      category: "FEATURE_ANNOUNCEMENT" as const,
      storySource: `story "New Feature: Dark Mode"
  navigate "https://app.example.com/settings/appearance"
  assert visible "Appearance Settings"
  click "radio:Light Mode"
  wait 1s
  click "radio:Dark Mode"
  wait 1s
  assert visible ".dark-theme-active"
  navigate "https://app.example.com/dashboard"
  wait 1s
  assert visible ".dashboard-dark"
  click ".widget:Analytics"
  wait for ".chart-rendered"
  assert visible ".chart-dark-theme"`,
      workspaceId: null,
      forkCount: 0,
    },

    // ─── BUG_REPRODUCTION (2) ───
    {
      name: "Form Validation Bug Report",
      description:
        "Reproduce a form validation bug where invalid input is accepted.",
      category: "BUG_REPRODUCTION" as const,
      storySource: `story "Bug: Email Validation Bypass"
  navigate "https://app.example.com/signup"
  type "#email" "not-an-email"
  type "#password" "short"
  click "button:Sign Up"
  wait 1s
  assert visible ".error-message"
  type "#email" "valid@test.com"
  type "#password" "ab"
  click "button:Sign Up"
  wait 1s
  assert visible "Password must be at least 8 characters"`,
      workspaceId: null,
      forkCount: 0,
    },
    {
      name: "Navigation State Bug",
      description:
        "Reproduce a bug where browser back button loses form state.",
      category: "BUG_REPRODUCTION" as const,
      storySource: `story "Bug: Back Button Loses Form State"
  navigate "https://app.example.com/form"
  type "#name" "John Doe"
  type "#email" "john@example.com"
  type "#message" "This is a test message"
  click "a:Terms of Service"
  wait for "Terms of Service"
  navigate back
  wait 1s
  assert value "#name" "John Doe"
  assert value "#email" "john@example.com"
  assert value "#message" "This is a test message"`,
      workspaceId: null,
      forkCount: 0,
    },

    // ─── INTERNAL_TRAINING (1) ───
    {
      name: "CRM Data Entry Training",
      description:
        "Step-by-step training for entering customer data in the company CRM.",
      category: "INTERNAL_TRAINING" as const,
      storySource: `story "CRM Data Entry Training"
  navigate "https://crm.example.com/contacts/new"
  wait for "New Contact"
  type "#first-name" "Alice"
  type "#last-name" "Johnson"
  type "#company" "Acme Corp"
  type "#email" "alice@acme.com"
  type "#phone" "+1-555-0123"
  click "select:Lead Source"
  click "option:Website"
  click "select:Status"
  click "option:Qualified"
  type "#notes" "Met at conference, interested in enterprise plan"
  click "button:Save Contact"
  wait for "Contact saved"
  assert visible "Alice Johnson"`,
      workspaceId: null,
      forkCount: 0,
    },
  ];

  console.log("Seeding 12 templates across 9 categories...");

  for (const template of templates) {
    await prisma.template.upsert({
      where: {
        // Use name as unique identifier for idempotent seeding
        id: `seed-${template.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}`,
      },
      update: {
        description: template.description,
        category: template.category,
        storySource: template.storySource,
      },
      create: {
        id: `seed-${template.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}`,
        name: template.name,
        description: template.description,
        category: template.category,
        storySource: template.storySource,
        workspaceId: template.workspaceId,
        forkCount: template.forkCount,
      },
    });
  }

  console.log("Seeded 12 templates successfully.");
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error("Seed failed:", e);
    await prisma.$disconnect();
    process.exit(1);
  });
