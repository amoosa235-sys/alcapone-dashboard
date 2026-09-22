import { AddMenu, MenuOption } from "./add-menu";

/**
 * The three "add an account" menus. Split out from the page so the markup can
 * be rendered without a session behind it.
 */
export function AddAccountMenus({
  shopifyReady,
  canManage,
}: {
  shopifyReady: boolean;
  canManage: boolean;
}) {
  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-medium">Add an account</h2>
      <div className="grid items-start gap-3 sm:grid-cols-3">
        <AddMenu label="Add a Shopify account">
          <MenuOption
            name="Shopify store"
            note={shopifyReady ? undefined : "Needs setup"}
          >
            {!canManage ? (
              <p className="text-sm text-black/60 dark:text-white/60">
                Only an owner or admin can connect a store.
              </p>
            ) : (
              <>
                <form
                  action="/api/shopify/install"
                  method="get"
                  className="flex flex-col gap-2"
                >
                  <input
                    name="shop"
                    placeholder="acme-supplies.myshopify.com"
                    required
                    disabled={!shopifyReady}
                    autoCapitalize="none"
                    autoCorrect="off"
                    spellCheck={false}
                    className="rounded-md border border-black/15 px-3 py-2 text-sm disabled:opacity-50 dark:border-white/20"
                  />
                  <button
                    disabled={!shopifyReady}
                    className="rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background disabled:opacity-50"
                  >
                    Connect
                  </button>
                </form>
                <p className="text-xs text-black/50 dark:text-white/50">
                  {shopifyReady
                    ? "You will be sent to Shopify to approve the permissions, then back here. Connect as many stores as you like."
                    : "Add SHOPIFY_API_KEY and SHOPIFY_API_SECRET in Vercel from a Shopify Partner app, then redeploy, and this turns on."}
                </p>
              </>
            )}
          </MenuOption>
        </AddMenu>

        <AddMenu label="Add an email account">
          <MenuOption name="Microsoft 365 (Outlook)" note="Coming next">
            <p className="text-xs text-black/50 dark:text-white/50">
              Connects a mailbox and pulls customer emails in as tickets.
              This is the step I am on after Shopify.
            </p>
          </MenuOption>
        </AddMenu>

        <AddMenu label="Add a social account">
          <MenuOption name="WhatsApp Business" note="Planned">
            <p className="text-xs text-black/50 dark:text-white/50">
              One number per workspace, from the WhatsApp Business API.
            </p>
          </MenuOption>
          <MenuOption name="Instagram" note="Not scoped" />
          <MenuOption name="Facebook" note="Not scoped" />
          <p className="text-xs text-black/50 dark:text-white/50">
            Instagram and Facebook are not in the build plan yet. Say the
            word and they go on it.
          </p>
        </AddMenu>
      </div>
    </section>
  );
}
