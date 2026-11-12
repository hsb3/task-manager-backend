/// <reference path="../pb_data/types.d.ts" />
// v2: the users reset-password and verification mails link to the account app (decision:account-app-mail-links).
migrate(
  (app) => {
    const users = app.findCollectionByNameOrId("users");
    const swap = (tpl, from, to) => {
      if (tpl.body.indexOf(from) < 0) throw new Error("account_app_mail_links: template lacks " + from);
      tpl.body = tpl.body.split(from).join(to);
    };
    swap(
      users.resetPasswordTemplate,
      "{APP_URL}/_/#/auth/confirm-password-reset/{TOKEN}",
      "{APP_URL}/account/#/auth/password-reset-confirm?token={TOKEN}",
    );
    swap(
      users.verificationTemplate,
      "{APP_URL}/_/#/auth/confirm-verification/{TOKEN}",
      "{APP_URL}/account/#/auth/email-verification-confirm?token={TOKEN}",
    );
    app.save(users);
  },
  (app) => {
    const users = app.findCollectionByNameOrId("users");
    const back = (tpl, from, to) => {
      tpl.body = tpl.body.split(from).join(to);
    };
    back(
      users.resetPasswordTemplate,
      "{APP_URL}/account/#/auth/password-reset-confirm?token={TOKEN}",
      "{APP_URL}/_/#/auth/confirm-password-reset/{TOKEN}",
    );
    back(
      users.verificationTemplate,
      "{APP_URL}/account/#/auth/email-verification-confirm?token={TOKEN}",
      "{APP_URL}/_/#/auth/confirm-verification/{TOKEN}",
    );
    app.save(users);
  },
);
