/* eslint-disable @typescript-eslint/no-explicit-any */
declare module "nodemailer" {
  const nodemailer: any;
  export default nodemailer;
}

declare module "mailparser" {
  export const simpleParser: any;
}

declare module "nodemailer/lib/mail-composer/index.js" {
  const MailComposer: any;
  export default MailComposer;
}
