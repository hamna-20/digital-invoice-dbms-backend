// Promotes or demotes an account's role.
//
// Every account is created as 'sales' (least privilege), so one account has to
// be promoted before returns can be approved or invoices voided:
//
//   npm run set-role -- --email you@example.test --role admin
//
// Available roles: sales | accounts | manager | admin

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaMssql } from '@prisma/adapter-mssql';

const ROLES = ['sales', 'accounts', 'manager', 'admin'];

function readArgs(argv) {
    const args = {};
    for (let i = 0; i < argv.length; i += 1) {
        if (argv[i].startsWith('--')) {
            args[argv[i].slice(2)] = argv[i + 1];
            i += 1;
        }
    }
    return args;
}

const args = readArgs(process.argv.slice(2));
const email = (args.email ?? '').trim().toLowerCase();
const role = (args.role ?? '').trim().toLowerCase();

if (!email || !role || !ROLES.includes(role)) {
    console.error(`Usage: npm run set-role -- --email <address> --role <${ROLES.join('|')}>`);
    process.exit(1);
}

const prisma = new PrismaClient({
    adapter: new PrismaMssql(process.env.DATABASE_URL),
});

try {
    const user = await prisma.user.findUnique({ where: { email }, select: { id: true, fullName: true, role: true } });
    if (!user) {
        console.error(`No account found for ${email}`);
        process.exitCode = 1;
    } else {
        await prisma.user.update({ where: { id: user.id }, data: { role } });
        console.log(`${user.fullName} <${email}>: ${user.role} -> ${role}`);
    }
} catch (error) {
    console.error(`Failed to update role: ${error.message}`);
    process.exitCode = 1;
} finally {
    await prisma.$disconnect();
}
