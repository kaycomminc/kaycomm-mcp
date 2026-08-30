#!/usr/bin/env node
/**
 * FSG Fall IET — LinkedIn Campaign Builder
 *
 * Creates:
 *   1. Campaign Group: "FSG Fall IET - LinkedIn" ($2,750 total, Aug 18 2026 – Jan 1 2027)
 *   2. Campaign: "FSG Fall IET - State Employees" (Sponsored Content, website visits)
 *   3. Two ads (Ad A & Ad B) with images from Meta ad sets 1 & 2
 *
 * Usage: node build-fsg-linkedin.js
 */

const LI_TOKEN = process.env.LINKEDIN_ACCESS_TOKEN;
if (!LI_TOKEN) {
    console.error("Set LINKEDIN_ACCESS_TOKEN env var first.");
    process.exit(1);
}
const ACCT = "513144628";
const ORG_ID = "92589471";
const API_VERSION = "202608";

const FLIGHT_START = 1787025600000; // Aug 18, 2026 UTC
const FLIGHT_END   = 1798779600000; // Jan 1, 2027 UTC

const AD_A_TEXT = `JOIN NOW · Calling all State of Florida Employees! Take your service to the State to the next level — JOIN the Florida State Guard. If you are an FSG Soldier and a State of Florida employee, you will receive up to 240 leave hours for training and activation. In Florida, we don't stand alone. Our state becomes a community. And when it matters most, we show up. Do you have what it takes? Find out. APPLY to join the Florida State Guard at floridastateguard.org/serve.
#FloridaStateGuard #WhatItTakes #ServeFL`;

const AD_B_TEXT = `JOIN NOW · Calling all State of Florida Employees! If you are an FSG Soldier and a State of Florida employee, you will receive up to 240 leave hours for training and activation. From response to recovery, we navigate where roads disappear. We operate when the grid blacks out. We move through air, land, and sea to reach those in need. Do you have what it takes? Find out. APPLY to join the Florida State Guard at floridastateguard.org/serve
#FloridaStateGuard #WhatItTakes #ServeFL`;

const LANDING_URL = "https://floridastateguard.org/serve";

async function liPost(path, body) {
    const url = path.startsWith("http") ? path : `https://api.linkedin.com/rest${path}`;
    const res = await fetch(url, {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${LI_TOKEN}`,
            "LinkedIn-Version": API_VERSION,
            "X-Restli-Protocol-Version": "2.0.0",
            "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
    });
    const idHeader = res.headers.get("x-restli-id") || res.headers.get("x-linkedin-id");
    let data = null;
    const text = await res.text();
    if (text) try { data = JSON.parse(text); } catch {}
    if (!res.ok) {
        console.error(`  FAILED ${res.status}:`, JSON.stringify(data, null, 2));
        return null;
    }
    return { id: idHeader, data, status: res.status };
}

async function liGet(path) {
    const url = path.startsWith("http") ? path : `https://api.linkedin.com/rest${path}`;
    const res = await fetch(url, {
        headers: {
            "Authorization": `Bearer ${LI_TOKEN}`,
            "LinkedIn-Version": API_VERSION,
            "X-Restli-Protocol-Version": "2.0.0",
        },
    });
    return res.json();
}

async function liPatch(path, body) {
    const url = path.startsWith("http") ? path : `https://api.linkedin.com/rest${path}`;
    const res = await fetch(url, {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${LI_TOKEN}`,
            "LinkedIn-Version": API_VERSION,
            "X-Restli-Protocol-Version": "2.0.0",
            "Content-Type": "application/json",
            "X-Restli-Method": "PARTIAL_UPDATE",
        },
        body: JSON.stringify({ patch: { $set: body } }),
    });
    if (!res.ok) {
        const text = await res.text();
        console.error(`  PATCH FAILED ${res.status}:`, text);
        return false;
    }
    return true;
}

async function main() {
    console.log("=== FSG Fall IET — LinkedIn Campaign Builder ===\n");

    // ── Step 1: Campaign Group (already created) ──
    const cgId = "1201910504";
    console.log(`1. Using existing Campaign Group: ${cgId} (FSG Fall IET - LinkedIn)`);

    // ── Step 2: Campaign (already created) ──
    const campId = "882350234";
    console.log(`\n2. Using existing Campaign: ${campId} (FSG Fall IET - State Employees)`);

    // ── Step 3: Create Ad Creatives (Direct Sponsored Content) ──
    // Uses adCreatives with inline content — no separate post needed
    console.log("\n3. Creating Ad Creative A (Direct Sponsored Content)...");
    const creativeA = await liPost(`/adAccounts/${ACCT}/creatives`, {
        campaign: `urn:li:sponsoredCampaign:${campId}`,
        content: {
            textAd: {
                headline: "Do You Have What It Takes?",
                description: AD_A_TEXT,
                landingPage: LANDING_URL,
            }
        },
        intendedStatus: "PAUSED",
    });
    if (!creativeA) {
        // Try alternative format: sponsored content with inline post
        console.log("   Trying alternative: inline sponsored update format...");
        const creativeA2 = await liPost(`/adAccounts/${ACCT}/creatives`, {
            campaign: `urn:li:sponsoredCampaign:${campId}`,
            intendedStatus: "PAUSED",
            content: {
                sponsoredUpdate: {
                    account: `urn:li:sponsoredAccount:${ACCT}`,
                    author: `urn:li:organization:${ORG_ID}`,
                    commentary: AD_A_TEXT,
                    content: {
                        article: {
                            source: LANDING_URL,
                            title: "Do You Have What It Takes?",
                            description: "Florida State Guard - Apply Now",
                        }
                    },
                    visibility: "SPONSORED",
                }
            },
        });
        if (!creativeA2) console.error("   Creative A failed both approaches");
        else console.log(`   Creative A: ${creativeA2.id}`);
    } else {
        console.log(`   Creative A: ${creativeA.id}`);
    }

    console.log("\n   Creating Ad Creative B...");
    const creativeB = await liPost(`/adAccounts/${ACCT}/creatives`, {
        campaign: `urn:li:sponsoredCampaign:${campId}`,
        content: {
            textAd: {
                headline: "Do You Have What It Takes?",
                description: AD_B_TEXT,
                landingPage: LANDING_URL,
            }
        },
        intendedStatus: "PAUSED",
    });
    if (!creativeB) {
        const creativeB2 = await liPost(`/adAccounts/${ACCT}/creatives`, {
            campaign: `urn:li:sponsoredCampaign:${campId}`,
            intendedStatus: "PAUSED",
            content: {
                sponsoredUpdate: {
                    account: `urn:li:sponsoredAccount:${ACCT}`,
                    author: `urn:li:organization:${ORG_ID}`,
                    commentary: AD_B_TEXT,
                    content: {
                        article: {
                            source: LANDING_URL,
                            title: "Do You Have What It Takes?",
                            description: "Florida State Guard - Apply Now",
                        }
                    },
                    visibility: "SPONSORED",
                }
            },
        });
        if (!creativeB2) console.error("   Creative B failed both approaches");
        else console.log(`   Creative B: ${creativeB2.id}`);
    } else {
        console.log(`   Creative B: ${creativeB.id}`);
    }

    // ── Summary ──
    console.log("\n=== BUILD COMPLETE ===");
    console.log(`Campaign Group: ${cgId} (FSG Fall IET - LinkedIn)`);
    console.log(`Campaign:       ${campId} (FSG Fall IET - State Employees)`);
    console.log(`Ad A Post:      ${postAUrn}`);
    console.log(`Ad B Post:      ${postBUrn}`);
    console.log(`Creative A:     ${creativeA?.id || "FAILED"}`);
    console.log(`Creative B:     ${creativeB?.id || "FAILED"}`);
    console.log(`\nStatus: PAUSED — review in Campaign Manager before enabling.`);
    console.log(`Flight: Aug 18, 2026 – Jan 1, 2027 | Budget: $2,750 | Daily: $20`);
}

main().catch(err => { console.error("Fatal:", err); process.exit(1); });
