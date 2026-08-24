// netlify/functions/scrape-linkedin.js
// NO node-fetch required — uses native fetch

exports.handler = async (event) => {
    // Allow only POST
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    try {
        const { url } = JSON.parse(event.body);
        
        if (!url || !url.includes('linkedin.com/in/')) {
            return {
                statusCode: 400,
                body: JSON.stringify({ error: 'Invalid LinkedIn URL. Must be linkedin.com/in/...' })
            };
        }

        // Extract username from URL
        const username = url.match(/\/in\/([^\/?#]+)/)?.[1];
        if (!username) {
            return {
                statusCode: 400,
                body: JSON.stringify({ error: 'Could not extract username from URL' })
            };
        }

        // ============ METHOD 1: Try direct fetch ============
        let html = await fetchWithHeaders(url);
        let data = null;

        if (html && !html.includes('login') && !html.includes('signin')) {
            data = extractData(html, url);
            if (data && data.fullName) {
                return {
                    statusCode: 200,
                    body: JSON.stringify({ ...data, method: 'direct_fetch' })
                };
            }
        }

        // ============ METHOD 2: Try Google Cache ============
        html = await fetchGoogleCache(url);
        if (html && !html.includes('login')) {
            data = extractData(html, url);
            if (data && data.fullName) {
                return {
                    statusCode: 200,
                    body: JSON.stringify({ ...data, method: 'google_cache' })
                };
            }
        }

        // ============ METHOD 3: Try CORS Proxy ============
        html = await fetchCorsProxy(url);
        if (html && !html.includes('login')) {
            data = extractData(html, url);
            if (data && data.fullName) {
                return {
                    statusCode: 200,
                    body: JSON.stringify({ ...data, method: 'cors_proxy' })
                };
            }
        }

        // ============ METHOD 4: Try to extract from URL ============
        const fallbackData = extractFromURL(username, url);
        if (fallbackData && fallbackData.fullName) {
            return {
                statusCode: 200,
                body: JSON.stringify({ 
                    ...fallbackData, 
                    method: 'url_fallback', 
                    note: 'Partial data extracted from URL. Profile may be private.'
                })
            };
        }

        // ============ If all methods fail ============
        return {
            statusCode: 404,
            body: JSON.stringify({ 
                error: 'Could not fetch profile data. This profile may be completely private.',
                note: 'Please use the screenshot upload method for this profile.',
                username: username
            })
        };

    } catch (error) {
        console.error('Scraping error:', error);
        return {
            statusCode: 500,
            body: JSON.stringify({ error: 'Scraping failed: ' + error.message })
        };
    }
};

// ============ FETCH WITH HEADERS ============
async function fetchWithHeaders(url) {
    const headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Sec-Fetch-User': '?1',
        'Cache-Control': 'no-cache'
    };

    try {
        const res = await fetch(url, { headers });
        if (res.ok) {
            return await res.text();
        }
    } catch(e) {}
    return null;
}

// ============ FETCH GOOGLE CACHE ============
async function fetchGoogleCache(url) {
    try {
        const cacheUrl = `https://webcache.googleusercontent.com/search?q=cache:${encodeURIComponent(url)}`;
        const res = await fetch(cacheUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            }
        });
        if (res.ok) {
            return await res.text();
        }
    } catch(e) {}
    return null;
}

// ============ FETCH CORS PROXY ============
async function fetchCorsProxy(url) {
    const proxies = [
        `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
        `https://corsproxy.io/?url=${encodeURIComponent(url)}`
    ];

    for (const proxyUrl of proxies) {
        try {
            const res = await fetch(proxyUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                }
            });
            if (res.ok) {
                const text = await res.text();
                if (!text.includes('login') && !text.includes('signin')) {
                    return text;
                }
            }
        } catch(e) {}
    }
    return null;
}

// ============ EXTRACT FROM URL ============
function extractFromURL(username, url) {
    const data = {
        fullName: '',
        firstName: '',
        lastName: '',
        jobTitle: '',
        company: '',
        location: '',
        industry: '',
        about: '',
        experience: [],
        skills: [],
        linkedinUrl: url,
        scrapedAt: new Date().toISOString(),
        partialData: true
    };

    // Parse name from URL
    const nameParts = username.split('-');
    if (nameParts.length >= 2) {
        const formattedName = nameParts.map(p => p.charAt(0).toUpperCase() + p.slice(1).replace(/[0-9]/g, '')).join(' ');
        data.fullName = formattedName;
        const parts = data.fullName.split(' ');
        data.firstName = parts[0] || '';
        data.lastName = parts.slice(1).join(' ') || '';
    }

    // Try to extract company from URL
    const companyMatch = username.match(/(?:at|for|with)-([a-z]+)(?:-|$)/i);
    if (companyMatch) {
        data.company = companyMatch[1].charAt(0).toUpperCase() + companyMatch[1].slice(1);
    }

    return data;
}

// ============ EXTRACT DATA FROM HTML ============
function extractData(html, url) {
    const data = {
        fullName: '',
        firstName: '',
        lastName: '',
        jobTitle: '',
        company: '',
        location: '',
        industry: '',
        about: '',
        experience: [],
        education: [],
        skills: [],
        linkedinUrl: url,
        scrapedAt: new Date().toISOString()
    };

    // ============ Extract from JSON-LD ============
    const jsonLdRegex = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g;
    let match;
    while ((match = jsonLdRegex.exec(html)) !== null) {
        try {
            const json = JSON.parse(match[1]);
            if (json['@type'] === 'Person') {
                if (json.name) {
                    data.fullName = json.name;
                    const parts = json.name.split(' ');
                    data.firstName = parts[0] || '';
                    data.lastName = parts.slice(1).join(' ') || '';
                }
                if (json.jobTitle) data.jobTitle = json.jobTitle;
                if (json.worksFor?.name) data.company = json.worksFor.name;
                if (json.location?.address?.addressCountry) data.location = json.location.address.addressCountry;
                if (json.description) data.about = json.description;
            }
        } catch(e) {}
    }

    // ============ Extract from Meta Tags ============
    const metaTitle = html.match(/<meta property="og:title" content="([^"]*)"/);
    if (metaTitle && metaTitle[1]) {
        let name = metaTitle[1].replace(' | LinkedIn', '').replace(' - LinkedIn', '').trim();
        if (name && !data.fullName) {
            data.fullName = name;
            const parts = name.split(' ');
            data.firstName = parts[0] || '';
            data.lastName = parts.slice(1).join(' ') || '';
        }
    }

    const metaDesc = html.match(/<meta property="og:description" content="([^"]*)"/);
    if (metaDesc && metaDesc[1]) {
        const desc = metaDesc[1];
        if (!data.jobTitle) {
            const titleMatch = desc.match(/^([^·|,]+)/);
            if (titleMatch) data.jobTitle = titleMatch[1].trim();
        }
        if (!data.company) {
            const companyMatch = desc.match(/(?:at|@)\s+([A-Z][a-zA-Z0-9\s&.]+)/);
            if (companyMatch) data.company = companyMatch[1].trim();
        }
    }

    // ============ Extract from HTML Elements ============
    if (!data.fullName) {
        const h1Match = html.match(/<h1[^>]*>([^<]*)<\/h1>/);
        if (h1Match && h1Match[1].trim()) {
            data.fullName = h1Match[1].trim();
            const parts = data.fullName.split(' ');
            data.firstName = parts[0] || '';
            data.lastName = parts.slice(1).join(' ') || '';
        }
    }

    if (!data.jobTitle) {
        const titlePatterns = [
            /<div[^>]*class="[^"]*text-body-medium[^"]*"[^>]*>([^<]*)<\/div>/,
            /<div[^>]*class="[^"]*headline[^"]*"[^>]*>([^<]*)<\/div>/
        ];
        for (const pattern of titlePatterns) {
            const match = html.match(pattern);
            if (match && match[1].trim()) {
                data.jobTitle = match[1].trim();
                break;
            }
        }
    }

    if (!data.company) {
        const companyPatterns = [
            /<a[^>]*data-anonymize="company-name"[^>]*>([^<]*)<\/a>/,
            /"companyName":"([^"]+)"/
        ];
        for (const pattern of companyPatterns) {
            const match = html.match(pattern);
            if (match && match[1].trim()) {
                data.company = match[1].trim();
                break;
            }
        }
    }

    if (!data.location) {
        const locMatch = html.match(/<span[^>]*class="[^"]*location[^"]*"[^>]*>([^<]*)<\/span>/);
        if (locMatch && locMatch[1].trim()) {
            data.location = locMatch[1].trim();
        }
    }

    // ============ Extract About ============
    if (!data.about) {
        const aboutMatch = html.match(/"summary":"([^"]+)"/);
        if (aboutMatch) {
            data.about = aboutMatch[1].replace(/\\n/g, '\n').replace(/\\"/g, '"');
        }
    }

    // ============ Extract Experience ============
    const expMatch = html.match(/"positions":\[([\s\S]*?)\]/);
    if (expMatch) {
        try {
            const positions = JSON.parse('[' + expMatch[1] + ']');
            if (Array.isArray(positions)) {
                data.experience = positions.map(p => {
                    const title = p.title || '';
                    const company = p.companyName || '';
                    const start = p.dateRange?.start || '';
                    const end = p.dateRange?.end || 'Present';
                    return `${title} at ${company} (${start} - ${end})`.trim();
                }).filter(Boolean);
            }
        } catch(e) {}
    }

    // ============ Extract Skills ============
    const skillsMatch = html.match(/"skills":\[([\s\S]*?)\]/);
    if (skillsMatch) {
        try {
            const skills = JSON.parse('[' + skillsMatch[1] + ']');
            if (Array.isArray(skills)) {
                data.skills = skills.map(s => s.name || s).filter(Boolean);
            }
        } catch(e) {}
    }

    // ============ Extract Education ============
    const eduMatch = html.match(/"education":\[([\s\S]*?)\]/);
    if (eduMatch) {
        try {
            const edu = JSON.parse('[' + eduMatch[1] + ']');
            if (Array.isArray(edu)) {
                data.education = edu.map(e => {
                    const school = e.schoolName || '';
                    const degree = e.degreeName || '';
                    return `${degree} at ${school}`.trim();
                }).filter(Boolean);
            }
        } catch(e) {}
    }

    // ============ Clean up ============
    Object.keys(data).forEach(key => {
        if (typeof data[key] === 'string') {
            data[key] = data[key]
                .replace(/\\/g, '')
                .replace(/"/g, '')
                .replace(/&quot;/g, '"')
                .replace(/&amp;/g, '&')
                .trim();
        }
        if (Array.isArray(data[key])) {
            data[key] = data[key].filter(Boolean);
        }
    });

    return data;
}
