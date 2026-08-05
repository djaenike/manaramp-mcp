import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

// The board used to live directly at "/" (a single hardcoded room). Now that rooms are created
// through the lobby, "/" is just a front door.
export const load: PageServerLoad = () => {
	throw redirect(307, '/lobby');
};
