
#version 330

#define NUM_OBJECTS		6	// uniform buffer would be better
#define TRACE_DEPTH		5

#define ONE_OVER_PI		0.3183098861837906
#define PI				3.1415926535897932
#define TWO_PI			6.2831853071795864

#ifndef FLT_MAX
#define FLT_MAX			3.402823466e+38
#endif

uniform sampler2D prevIteration;

uniform mat4	matViewProjInv;
uniform vec3	eyePos;
uniform float	time;
uniform float	currSample;

in vec2 tex;

out vec4 my_FragColor0;

struct SceneObject
{
	uint	type;
	vec4	params1;
	vec4	params2;
	vec3	color;
};

// --- Ray-object intersection functions -------------------------------------------

float RayIntersectPlane(out vec3 n, vec4 p, vec3 start, vec3 dir)
{
	float u = (dir.x * p.x + dir.y * p.y + dir.z * p.z);
	float t = 0;

	n = p.xyz;

	if (u < -1e-5)
		t = -(start.x * p.x + start.y * p.y + start.z * p.z + p.w) / u;

	return ((t > 0.0f) ? t : FLT_MAX);
}

float RayIntersectSphere(out vec3 n, vec3 center, float radius, vec3 start, vec3 dir)
{
	vec3 stoc = start - center;

	float a = dot(dir, dir);
	float b = 2.0 * dot(stoc, dir);
	float c = dot(stoc, stoc) - radius * radius;
	float d = b * b - 4.0 * a * c;
	float t = 0.0;

	if (d > 0.0)
		t = (-b - sqrt(d)) / (2.0 * a);

	n = normalize(start + t * dir - center);

	return ((t > 0.0) ? t : FLT_MAX);
}

float RayIntersectBox(out vec3 n, vec3 pos, vec3 size, vec3 start, vec3 dir)
{
	vec3 hsize = size * 0.5;
	vec3 bmin = pos - hsize;
	vec3 bmax = pos + hsize;

	vec3 m1 = bmin - start;
	vec3 m2 = bmax - start;

	vec3 tmin = m1 / dir;
	vec3 tmax = m2 / dir;

	vec3 t1 = min(tmin, tmax);
	vec3 t2 = max(tmin, tmax);

	float tn = max(max(t1.x, t1.y), t1.z);
	float tf = min(min(t2.x, t2.y), t2.z);

	float t = FLT_MAX;

	if (tn < tf && tf > 0.0)
		t = tn;

	vec3 p = start + (t - 1e-3) * dir;

	if (p.x < bmin.x + 1e-4)
		n = vec3(-1.0, 0.0, 0.0);
	else if (p.x > bmax.x - 1e-4)
		n = vec3(1.0, 0.0, 0.0);
	else if (p.y < bmin.y + 1e-4)
		n = vec3(0.0, -1.0, 0.0);
	else if (p.y > bmax.y - 1e-4)
		n = vec3(0.0, 1.0, 0.0);
	else if (p.z < bmin.z + 1e-4)
		n = vec3(0.0, 0.0, -1.0);
	else
		n = vec3(0.0, 0.0, 1.0);

	return t;
}

float RayIntersectDisk(out vec3 n, vec3 pos, vec3 axis, float radius, vec3 start, vec3 dir)
{
	vec4 p = vec4(axis, -dot(pos, axis));
	float t = RayIntersectPlane(n, p, start, dir);

	if (t != FLT_MAX) {
		vec3 y = start + t * dir - pos;

		if (dot(y, y) > radius * radius)
			t = FLT_MAX;
	}

	return ((t > 0.0) ? t : FLT_MAX);
}

float RayIntersectCylinder(out vec3 n, vec4 pos, vec4 axis, vec3 start, vec3 dir)
{
	float radius = pos.w;
	float halfheight = axis.w * 0.5;

	vec3 x = cross(axis.xyz, dir);
	vec3 y = cross(axis.xyz, start - pos.xyz);

	float a = dot(x, x);
	float b = 2.0 * dot(x, y);
	float c = dot(y, y) - radius * radius;
	float d = b * b - 4.0 * a * c;
	float t = 0.0;
	float test;

	if (d > 0.0)
		t = (-b - sqrt(d)) / (2.0 * a);

	x = start + t * dir;
	test = dot(x - pos.xyz, axis.xyz);

	if (abs(test) > halfheight) {
		t = RayIntersectDisk(n, pos.xyz + halfheight * axis.xyz, axis.xyz, radius, start, dir);

		if (t == FLT_MAX)
			t = RayIntersectDisk(n, pos.xyz - halfheight * axis.xyz, -axis.xyz, radius, start, dir);
	} else {
		y = cross(x - pos.xyz, axis.xyz);
		n = normalize(cross(axis.xyz, y));
	}

	return ((t > 0.0) ? t : FLT_MAX);
}

// --- Sampling functions ----------------------------------------------------------

float Random(vec3 pixel, vec3 scale, float seed)
{
	// NOTE: this function is sensitive to large seed values, so try to keep it small
	return fract(sin(dot(pixel + vec3(seed), scale)) * 43758.5453 + seed);
}

vec3 CosineSample(vec3 n, vec3 pixel, float seed)
{
	float u = Random(pixel, vec3(12.9898, 78.233, 151.7182), seed);
	float v = Random(pixel, vec3(63.7264, 10.873, 623.6736), seed);

	float phi = 2 * PI * u;
	float costheta = sqrt(v);
	float sintheta = sqrt(1 - costheta * costheta);

	vec3 H;

	H.x = sintheta * cos(phi);
	H.y = sintheta * sin(phi);
	H.z = costheta;

	vec3 up = ((abs(n.z) < 0.999) ? vec3(0, 0, 1) : vec3(1, 0, 0));
	vec3 tangent = normalize(cross(up, n));
	vec3 bitangent = cross(n, tangent);

	return tangent * H.x + bitangent * H.y + n * H.z;
}

// --- Path tracer -----------------------------------------------------------------

int FindIntersection(out vec3 pos, out vec3 norm, vec3 raystart, vec3 raydir, SceneObject objects[NUM_OBJECTS])
{
	vec3	bestn, n;
	float	t, bestt	= FLT_MAX;
	uint	geomtype;
	int		index		= NUM_OBJECTS;
	int		i;

	// find the first object that the ray hits
	for (i = 0; i < NUM_OBJECTS; ++i) {
		geomtype = (objects[i].type & (~1));

		if (geomtype == 2)
			t = RayIntersectPlane(n, objects[i].params1, raystart, raydir);
		else if (geomtype == 4)
			t = RayIntersectSphere(n, objects[i].params1.xyz, objects[i].params1.w, raystart, raydir);
		else if (geomtype == 8)
			t = RayIntersectBox(n, objects[i].params1.xyz, objects[i].params2.xyz, raystart, raydir);
		else if (geomtype == 16)
			t = RayIntersectCylinder(n, objects[i].params1, objects[i].params2, raystart, raydir);
		else
			t = FLT_MAX;

		if (t < bestt) {
			bestt	= t;
			bestn	= n;
			index	= i;
		}
	}

	if (index < NUM_OBJECTS) {
		pos = raystart + (bestt - 1e-3) * raydir;
		norm = bestn;
	}

	return index;
}

vec3 TraceScene(vec3 raystart, vec3 raydir, vec3 pixel, SceneObject objects[NUM_OBJECTS])
{
	vec3	inray;
	vec3	outray;
	vec3	n, p;
	vec3	indirect = vec3(1.0);
	vec3	lightlum = vec3(0.0);
	vec3	fr_cos_over_pdf;
	vec3	fd;
	int		index, j;

	p = raystart;
	outray = raydir;

	for (j = 0; j < TRACE_DEPTH; ++j) {
		index = FindIntersection(p, n, p, outray, objects);

		if (index >= NUM_OBJECTS)
			break;

		if (objects[index].type % 2 == 1) {
			// hit light
			lightlum = objects[index].color;
			break;
		}

		// Lambert (PDF = cos(theta) / PI)
		fd = objects[index].color * ONE_OVER_PI;

		inray = CosineSample(n, pixel, time + float(j));

		// cos(theta) drops out because of PDF
		fr_cos_over_pdf = fd * PI;
		indirect *= fr_cos_over_pdf;

		outray = inray;
	}

	return indirect * lightlum;
}

// --- Entry point -----------------------------------------------------------------

void main()
{
	// 2 - plane:		params1 = equation
	// 4 - sphere:		params1 = position, radius
	// 8 - box:			params1 = position, params2 = size
	// 16 - cylinder:	params1 = position, params2 = axis, height
	// | 1 -> light		color = emitted luminance

	SceneObject objects[NUM_OBJECTS] = SceneObject[NUM_OBJECTS](
		// don't forget to calculate accurate luminance values for area lights
		SceneObject(4|1,	vec4(0.75, 1.5, -1.4, 0.5),	vec4(0.0),					vec3(60.0)),	// <---- this is NOT flux!!!

		SceneObject(8,		vec4(0.0, 1.5, 1.6, 0.0),	vec4(5.0, 3.0, 0.5, 0.0),	vec3(1.0, 1.0, 1.0)),
		SceneObject(2,		vec4(-1.0, 0.0, 0.0, 4.0),	vec4(0.0),					vec3(1.0, 0.0, 0.0)),
		SceneObject(2,		vec4(1.0, 0.0, 0.0, 4.0),	vec4(0.0),					vec3(0.0, 1.0, 0.0)),
		SceneObject(2,		vec4(0.0, 0.0, -1.0, 3.5),	vec4(0.0),					vec3(1.0, 1.0, 1.0)),
		SceneObject(2,		vec4(0.0, 1.0, 0.0, 0.0),	vec4(0.0),					vec3(1.0, 1.0, 1.0))
	);

	vec4 spos = vec4(tex * 2.0 - vec2(1.0), 0.1, 1.0);
	vec4 wpos = matViewProjInv * spos;
	vec3 raydir;

	wpos /= wpos.w;
	raydir = normalize(wpos.xyz - eyePos);

	vec3 prev = texelFetch(prevIteration, ivec2(gl_FragCoord.xy), 0).rgb;
	vec3 curr = TraceScene(eyePos, raydir, spos.xyz, objects);
	float d = 1.0 / currSample;

	my_FragColor0 = vec4(mix(prev, curr, d), 1.0);
}