import { specsForMenu, type ChannelSpec } from "@/lib/channels/specs";

import { AddMenu, MenuOption } from "./add-menu";
import { ChannelForm } from "./channel-form";

/**
 * The three "add an account" menus. Every option opens the form for that
 * account, whether or not the integration behind it runs yet.
 *
 * Split out from the page so the markup can be rendered without a session
 * behind it.
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
          {specsForMenu("shopify").map((spec) => (
            <MenuOption
              key={spec.key}
              name={spec.name}
              note={shopifyReady ? undefined : "Needs setup"}
            >
              {canManage ? (
                <ShopifyConnectForm spec={spec} ready={shopifyReady} />
              ) : (
                <OwnersOnly />
              )}
            </MenuOption>
          ))}
        </AddMenu>

        <AddMenu label="Add an email account">
          {specsForMenu("email").map((spec) => (
            <MenuOption key={spec.key} name={spec.name} note="Not built yet">
              {canManage ? <ChannelForm spec={spec} /> : <OwnersOnly />}
            </MenuOption>
          ))}
        </AddMenu>

        <AddMenu label="Add a social account">
          {specsForMenu("social").map((spec) => (
            <MenuOption key={spec.key} name={spec.name} note="Not built yet">
              {canManage ? <ChannelForm spec={spec} /> : <OwnersOnly />}
            </MenuOption>
          ))}
        </AddMenu>
      </div>
    </section>
  );
}

function OwnersOnly() {
  return (
    <p className="text-xs text-black/60 dark:text-white/60">
      Only an owner or admin can add an account.
    </p>
  );
}

/**
 * Shopify is the one channel that does not take credentials here: the store
 * address is all it needs, and approving on Shopify's own screen is what
 * connects it. The field stays usable without the app's keys, because being
 * told what is missing on submit beats a box that will not accept typing.
 */
function ShopifyConnectForm({
  spec,
  ready,
}: {
  spec: ChannelSpec;
  ready: boolean;
}) {
  const [field] = spec.fields;

  return (
    <form
      action="/api/shopify/install"
      method="get"
      className="flex flex-col gap-3"
    >
      {!ready ? (
        <p className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs leading-relaxed">
          <strong className="font-semibold">Needs setup.</strong> Add
          SHOPIFY_API_KEY and SHOPIFY_API_SECRET in Vercel from a Shopify
          Partner app, then redeploy. Connecting will fail until you do.
        </p>
      ) : null}

      <label className="flex flex-col gap-1 text-xs">
        <span className="font-medium">{field.label}</span>
        <input
          name={field.name}
          placeholder={field.placeholder}
          required
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          className="rounded-md border border-black/15 px-3 py-2 text-sm dark:border-white/20"
        />
        {field.help ? (
          <span className="text-black/45 dark:text-white/45">{field.help}</span>
        ) : null}
      </label>

      <p className="text-xs text-black/45 dark:text-white/45">
        Where to find this: {spec.where}
      </p>

      <button className="rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background">
        Connect
      </button>
    </form>
  );
}
