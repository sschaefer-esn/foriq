from fastapi import Depends, HTTPException, Header
from utils.auth_utils import verify_token_and_version


async def get_current_user(authorization: str = Header(None)):
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Not authenticated")

    token = authorization.split(" ")[1]
    try:
        payload = verify_token_and_version(token)
        return payload
    except Exception:
        raise HTTPException(status_code=401, detail="Invalid token")


def require_role(*roles):
    async def role_checker(user=Depends(get_current_user)):
        if user.get("role") not in roles:
            raise HTTPException(status_code=403, detail="Permission denied")
        return user
    return role_checker
