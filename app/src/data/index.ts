import platformsData from "./platforms.json";
import listingsData from "./listings.json";
import partnerTypesData from "./partnerTypes.json";

export interface Group { id: string; name: string; icon: string; desc: string }
export interface Category { id: string; group: string; name: string; icon: string; desc: string }
export interface Platform { id: string; name: string; category: string; region: string; url: string; blurb: string; new?: boolean }
export interface Partnership { id: string; type: string; from: string; want: string[]; title: string; detail: string; give: string; get: string; size: string; posted: string; status: string; verified?: boolean; demo?: boolean }
export interface Deal { id: string; category: string; region: string; revenue: string; mode: string; summary: string; posted: string; status: string; demo?: boolean }
export interface Listings { partnerTypes: string[]; partnerships: Partnership[]; deals: Deal[] }

const d = platformsData as { groups: Group[]; categories: Category[]; platforms: Platform[] };
export const groups: Group[] = d.groups;
export const categories: Category[] = d.categories;
export const platforms: Platform[] = d.platforms;
export const listings = listingsData as Listings;

/* ── 제휴 방식 카탈로그 (2단계) ── */
export interface PartnerGoal { id: string; label: string }
export interface PartnerGroup { id: string; label: string; desc: string }
export interface PartnerType {
  id: string; group: string; label: string; desc: string;
  mechanics: string; example: string;
  settlement: "none" | "direct" | "share";
  effort: "light" | "mid" | "heavy";
  goals: string[];
}
export const partnerGoals = partnerTypesData.goals as PartnerGoal[];
export const partnerGroups = partnerTypesData.groups as PartnerGroup[];
export const partnerTypes = partnerTypesData.types as PartnerType[];

export const categoryById = (id: string) => categories.find((c) => c.id === id);
export const categoriesByGroup = (g: string) => categories.filter((c) => c.group === g);
export const countByCategory = (id: string) => platforms.filter((p) => p.category === id).length;
export const newCount = platforms.filter((p) => p.new).length;
