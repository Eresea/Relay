//! Small, typed calls to Linear's GraphQL API.

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::error::{Error, Result};

const GRAPHQL: &str = "https://api.linear.app/graphql";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Viewer {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub email: String,
    pub organization: Organization,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Organization {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub url_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Team {
    pub id: String,
    pub name: String,
    pub key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowState {
    pub id: String,
    pub name: String,
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub team: Option<TeamRef>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamRef {
    pub id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Issue {
    pub id: String,
    pub identifier: String,
    pub title: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub priority: u8,
    #[serde(default)]
    pub updated_at: String,
    pub state: Option<WorkflowState>,
    pub assignee: Option<Person>,
    pub project: Option<ProjectRef>,
    pub cycle: Option<CycleRef>,
    pub team: Team,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinearComment {
    pub id: String,
    pub body: String,
    pub created_at: String,
    pub user: Option<Person>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IssueDetail {
    pub issue: Issue,
    pub children: Vec<Issue>,
    pub comments: Vec<LinearComment>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Person {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRef {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CycleRef {
    pub id: String,
    pub name: String,
    pub number: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinearProject {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub start_date: Option<String>,
    #[serde(default)]
    pub target_date: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinearMilestone {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub target_date: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinearCycle {
    pub id: String,
    pub name: String,
    pub number: i64,
    #[serde(default)]
    pub starts_at: Option<String>,
    #[serde(default)]
    pub ends_at: Option<String>,
    #[serde(default)]
    pub is_active: bool,
    pub team: Team,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Initiative {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub target_date: Option<String>,
    #[serde(default)]
    pub projects: Vec<ProjectRef>,
}

#[derive(Deserialize)]
struct GraphqlResponse<T> {
    data: Option<T>,
    #[serde(default)]
    errors: Vec<GraphqlError>,
}

#[derive(Deserialize)]
struct GraphqlError {
    message: String,
}

pub async fn viewer(token: &str) -> Result<Viewer> {
    #[derive(Deserialize)]
    struct Data {
        viewer: Viewer,
    }

    Ok(query::<Data>(
        token,
        "query RelayViewer { viewer { id name email organization { id name urlKey } } }",
        json!({}),
    )
    .await?
    .viewer)
}

pub async fn teams(token: &str) -> Result<Vec<Team>> {
    #[derive(Deserialize)]
    struct Data {
        teams: Nodes<Team>,
    }

    Ok(query::<Data>(
        token,
        "query RelayTeams { teams { nodes { id name key } } }",
        json!({}),
    )
    .await?
    .teams
    .nodes)
}

pub async fn users(token: &str) -> Result<Vec<Person>> {
    #[derive(Deserialize)]
    struct Data {
        users: Nodes<Person>,
    }
    Ok(query::<Data>(
        token,
        "query RelayUsers { users(first: 100) { nodes { id name } } }",
        json!({}),
    )
    .await?
    .users
    .nodes)
}

pub async fn projects(token: &str) -> Result<Vec<LinearProject>> {
    #[derive(Deserialize)]
    struct Data {
        projects: Nodes<LinearProject>,
    }
    Ok(query::<Data>(
        token,
        "query RelayProjects { projects(first: 100) { nodes { id name description url startDate targetDate } } }",
        json!({}),
    )
    .await?
    .projects
    .nodes)
}

pub async fn create_project(
    token: &str,
    team_id: &str,
    name: &str,
    description: Option<&str>,
    start_date: Option<&str>,
    target_date: Option<&str>,
) -> Result<LinearProject> {
    #[derive(Deserialize)]
    struct Data {
        #[serde(rename = "projectCreate")]
        result: ProjectMutation,
    }
    let mut input = serde_json::Map::from_iter([
        ("name".into(), json!(name)),
        ("teamIds".into(), json!([team_id])),
    ]);
    if let Some(description) = description {
        input.insert("description".into(), json!(description));
    }
    if let Some(start_date) = start_date {
        input.insert("startDate".into(), json!(start_date));
    }
    if let Some(target_date) = target_date {
        input.insert("targetDate".into(), json!(target_date));
    }
    let data: Data = query(
        token,
        "mutation RelayProjectCreate($input: ProjectCreateInput!) { projectCreate(input: $input) { success project { id name description url startDate targetDate } } }",
        json!({ "input": input }),
    )
    .await?;
    data.result.into_value("Linear did not create the project")
}

pub async fn update_project(
    token: &str,
    project_id: &str,
    name: &str,
    description: &str,
    start_date: Option<&str>,
    target_date: Option<&str>,
) -> Result<LinearProject> {
    #[derive(Deserialize)]
    struct Data {
        #[serde(rename = "projectUpdate")]
        result: ProjectMutation,
    }
    let data: Data = query(
        token,
        "mutation RelayProjectUpdate($id: String!, $input: ProjectUpdateInput!) { projectUpdate(id: $id, input: $input) { success project { id name description url startDate targetDate } } }",
        json!({
            "id": project_id,
            "input": { "name": name, "description": description, "startDate": start_date, "targetDate": target_date }
        }),
    )
    .await?;
    data.result.into_value("Linear did not update the project")
}

pub async fn project_milestones(token: &str, project_id: &str) -> Result<Vec<LinearMilestone>> {
    #[derive(Deserialize)]
    struct ProjectNode {
        project_milestones: Nodes<LinearMilestone>,
    }
    #[derive(Deserialize)]
    struct Data {
        projects: Nodes<ProjectNode>,
    }
    let data: Data = query(
        token,
        "query RelayProjectMilestones($projectId: String!) { projects(filter: { id: { eq: $projectId } }, first: 1) { nodes { projectMilestones(first: 100) { nodes { id name description targetDate } } } } }",
        json!({ "projectId": project_id }),
    )
    .await?;
    Ok(data
        .projects
        .nodes
        .into_iter()
        .next()
        .map(|project| project.project_milestones.nodes)
        .unwrap_or_default())
}

pub async fn create_milestone(
    token: &str,
    project_id: &str,
    name: &str,
    description: Option<&str>,
    target_date: Option<&str>,
) -> Result<LinearMilestone> {
    #[derive(Deserialize)]
    struct Data {
        #[serde(rename = "projectMilestoneCreate")]
        result: MilestoneMutation,
    }
    let mut input = serde_json::Map::from_iter([
        ("projectId".into(), json!(project_id)),
        ("name".into(), json!(name)),
    ]);
    if let Some(description) = description {
        input.insert("description".into(), json!(description));
    }
    if let Some(target_date) = target_date {
        input.insert("targetDate".into(), json!(target_date));
    }
    let data: Data = query(
        token,
        "mutation RelayMilestoneCreate($input: ProjectMilestoneCreateInput!) { projectMilestoneCreate(input: $input) { success projectMilestone { id name description targetDate } } }",
        json!({ "input": input }),
    )
    .await?;
    data.result
        .into_value("Linear did not create the milestone")
}

pub async fn update_milestone(
    token: &str,
    milestone_id: &str,
    name: &str,
    description: &str,
    target_date: Option<&str>,
) -> Result<LinearMilestone> {
    #[derive(Deserialize)]
    struct Data {
        #[serde(rename = "projectMilestoneUpdate")]
        result: MilestoneMutation,
    }
    let data: Data = query(
        token,
        "mutation RelayMilestoneUpdate($id: String!, $input: ProjectMilestoneUpdateInput!) { projectMilestoneUpdate(id: $id, input: $input) { success projectMilestone { id name description targetDate } } }",
        json!({ "id": milestone_id, "input": { "name": name, "description": description, "targetDate": target_date } }),
    )
    .await?;
    data.result
        .into_value("Linear did not update the milestone")
}

pub async fn initiatives(token: &str) -> Result<Vec<Initiative>> {
    #[derive(Deserialize)]
    struct InitiativeNode {
        id: String,
        name: String,
        description: Option<String>,
        #[serde(rename = "targetDate")]
        target_date: Option<String>,
        projects: Nodes<ProjectRef>,
    }
    #[derive(Deserialize)]
    struct Data {
        initiatives: Nodes<InitiativeNode>,
    }
    Ok(query::<Data>(
        token,
        "query RelayInitiatives { initiatives(first: 100) { nodes { id name description targetDate projects { nodes { id name } } } } }",
        json!({}),
    )
    .await?
    .initiatives
    .nodes
    .into_iter()
    .map(|initiative| Initiative {
        id: initiative.id,
        name: initiative.name,
        description: initiative.description,
        target_date: initiative.target_date,
        projects: initiative.projects.nodes,
    })
    .collect())
}

pub async fn cycles(token: &str, team_id: &str) -> Result<Vec<LinearCycle>> {
    #[derive(Deserialize)]
    struct Data {
        cycles: Nodes<LinearCycle>,
    }
    Ok(query::<Data>(
        token,
        "query RelayCycles($teamId: String!) { cycles(filter: { team: { id: { eq: $teamId } } }, first: 100) { nodes { id name number startsAt endsAt isActive team { id name key } } } }",
        json!({ "teamId": team_id }),
    )
    .await?
    .cycles
    .nodes)
}

pub async fn project_issues(
    token: &str,
    project_id: &str,
    after: Option<&str>,
) -> Result<IssuePage> {
    issues(
        token,
        json!({ "project": { "id": { "eq": project_id } } }),
        after,
    )
    .await
}

pub async fn workflow_states(token: &str, team_id: &str) -> Result<Vec<WorkflowState>> {
    #[derive(Deserialize)]
    struct Data {
        #[serde(rename = "workflowStates")]
        workflow_states: Nodes<WorkflowState>,
    }

    Ok(query::<Data>(
        token,
        "query RelayWorkflowStates { workflowStates { nodes { id name type team { id } } } }",
        json!({}),
    )
    .await?
    .workflow_states
    .nodes)
    .map(|states| {
        states
            .into_iter()
            .filter(|state| state.team.as_ref().is_some_and(|team| team.id == team_id))
            .collect()
    })
}

pub async fn create_issue(
    token: &str,
    team_id: &str,
    title: &str,
    description: Option<&str>,
    assignee_id: Option<&str>,
    project_id: Option<&str>,
    project_milestone_id: Option<&str>,
    parent_id: Option<&str>,
) -> Result<Issue> {
    #[derive(Deserialize)]
    struct Data {
        #[serde(rename = "issueCreate")]
        result: MutationResult<Issue>,
    }

    let mut input = serde_json::Map::from_iter([
        ("teamId".into(), json!(team_id)),
        ("title".into(), json!(title)),
    ]);
    if let Some(description) = description {
        input.insert("description".into(), json!(description));
    }
    if let Some(assignee_id) = assignee_id {
        input.insert("assigneeId".into(), json!(assignee_id));
    }
    if let Some(project_id) = project_id {
        input.insert("projectId".into(), json!(project_id));
    }
    if let Some(project_milestone_id) = project_milestone_id {
        input.insert("projectMilestoneId".into(), json!(project_milestone_id));
    }
    if let Some(parent_id) = parent_id {
        input.insert("parentId".into(), json!(parent_id));
    }
    let data: Data = query(
        token,
        "mutation RelayIssueCreate($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { id identifier title description url priority updatedAt state { id name type } assignee { id name } project { id name } cycle { id name number } team { id name key } } } }",
        json!({ "input": input }),
    )
    .await?;
    data.result.into_value("Linear did not create the issue")
}

pub async fn issue_detail(token: &str, issue_id: &str) -> Result<IssueDetail> {
    #[derive(Deserialize)]
    struct IssueNode {
        #[serde(flatten)]
        issue: Issue,
        children: Nodes<Issue>,
        comments: Nodes<LinearComment>,
    }
    #[derive(Deserialize)]
    struct Data {
        issue: IssueNode,
    }
    let data: Data = query(
        token,
        "query RelayIssueDetail($id: String!) { issue(id: $id) { id identifier title description url priority updatedAt state { id name type } assignee { id name } project { id name } cycle { id name number } team { id name key } children(first: 50) { nodes { id identifier title description url priority updatedAt state { id name type } assignee { id name } project { id name } cycle { id name number } team { id name key } } } comments(first: 50) { nodes { id body createdAt user { id name } } } } }",
        json!({ "id": issue_id }),
    )
    .await?;
    Ok(IssueDetail {
        issue: data.issue.issue,
        children: data.issue.children.nodes,
        comments: data.issue.comments.nodes,
    })
}

pub async fn create_comment(token: &str, issue_id: &str, body: &str) -> Result<LinearComment> {
    #[derive(Deserialize)]
    struct Data {
        #[serde(rename = "commentCreate")]
        result: CommentMutation,
    }
    let data: Data = query(
        token,
        "mutation RelayCommentCreate($input: CommentCreateInput!) { commentCreate(input: $input) { success comment { id body createdAt user { id name } } } }",
        json!({ "input": { "issueId": issue_id, "body": body } }),
    )
    .await?;
    data.result.into_value("Linear did not create the comment")
}

pub async fn update_issue(
    token: &str,
    issue_id: &str,
    state_id: Option<&str>,
    assignee_id: Option<&str>,
    clear_assignee: bool,
    cycle_id: Option<&str>,
    clear_cycle: bool,
    priority: Option<u8>,
) -> Result<Issue> {
    #[derive(Deserialize)]
    struct Data {
        #[serde(rename = "issueUpdate")]
        result: MutationResult<Issue>,
    }

    let mut input = serde_json::Map::new();
    if let Some(state_id) = state_id {
        input.insert("stateId".into(), json!(state_id));
    }
    if let Some(assignee_id) = assignee_id {
        input.insert("assigneeId".into(), json!(assignee_id));
    }
    if clear_assignee {
        input.insert("assigneeId".into(), Value::Null);
    }
    if let Some(cycle_id) = cycle_id {
        input.insert("cycleId".into(), json!(cycle_id));
    }
    if clear_cycle {
        input.insert("cycleId".into(), Value::Null);
    }
    if let Some(priority) = priority {
        input.insert("priority".into(), json!(priority));
    }
    let data: Data = query(
        token,
        "mutation RelayIssueUpdate($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success issue { id identifier title description url priority updatedAt state { id name type } assignee { id name } project { id name } cycle { id name number } team { id name key } } } }",
        json!({
            "id": issue_id,
            "input": input
        }),
    )
    .await?;
    data.result.into_value("Linear did not update the issue")
}

#[derive(Deserialize)]
struct MutationResult<T> {
    success: bool,
    #[serde(rename = "issue")]
    value: Option<T>,
}

#[derive(Deserialize)]
struct ProjectMutation {
    success: bool,
    project: Option<LinearProject>,
}

#[derive(Deserialize)]
struct MilestoneMutation {
    success: bool,
    #[serde(rename = "projectMilestone")]
    milestone: Option<LinearMilestone>,
}

#[derive(Deserialize)]
struct CommentMutation {
    success: bool,
    comment: Option<LinearComment>,
}

impl CommentMutation {
    fn into_value(self, message: &str) -> Result<LinearComment> {
        if self.success {
            self.comment
                .ok_or_else(|| Error::LinearApi("Linear returned no comment".into()))
        } else {
            Err(Error::LinearApi(message.into()))
        }
    }
}

impl MilestoneMutation {
    fn into_value(self, message: &str) -> Result<LinearMilestone> {
        if self.success {
            self.milestone
                .ok_or_else(|| Error::LinearApi("Linear returned no milestone".into()))
        } else {
            Err(Error::LinearApi(message.into()))
        }
    }
}

impl ProjectMutation {
    fn into_value(self, message: &str) -> Result<LinearProject> {
        if self.success {
            self.project
                .ok_or_else(|| Error::LinearApi("Linear returned no project".into()))
        } else {
            Err(Error::LinearApi(message.into()))
        }
    }
}

impl<T> MutationResult<T> {
    fn into_value(self, message: &str) -> Result<T> {
        if self.success {
            self.value
                .ok_or_else(|| Error::LinearApi("Linear returned no issue".into()))
        } else {
            Err(Error::LinearApi(message.into()))
        }
    }
}

pub async fn my_issues(token: &str, assignee_id: &str, after: Option<&str>) -> Result<IssuePage> {
    issues(
        token,
        json!({ "assignee": { "id": { "eq": assignee_id } } }),
        after,
    )
    .await
}

async fn issues(token: &str, filter: Value, after: Option<&str>) -> Result<IssuePage> {
    #[derive(Deserialize)]
    struct Data {
        issues: IssueConnection,
    }

    let data: Data = query(
        token,
        "query RelayMyIssues($filter: IssueFilter, $after: String) { issues(filter: $filter, first: 50, after: $after) { nodes { id identifier title description url priority updatedAt state { id name type } assignee { id name } project { id name } cycle { id name number } team { id name key } } pageInfo { endCursor hasNextPage } } }",
        json!({
            "filter": filter,
            "after": after
        }),
    )
    .await?;
    Ok(IssuePage {
        issues: data.issues.nodes,
        end_cursor: data.issues.page_info.end_cursor,
        has_next_page: data.issues.page_info.has_next_page,
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IssuePage {
    pub issues: Vec<Issue>,
    pub end_cursor: Option<String>,
    pub has_next_page: bool,
}

#[derive(Deserialize)]
struct Nodes<T> {
    nodes: Vec<T>,
}

#[derive(Deserialize)]
struct IssueConnection {
    nodes: Vec<Issue>,
    #[serde(rename = "pageInfo")]
    page_info: PageInfo,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PageInfo {
    end_cursor: Option<String>,
    has_next_page: bool,
}

async fn query<T: DeserializeOwned>(token: &str, query: &str, variables: Value) -> Result<T> {
    let response = reqwest::Client::new()
        .post(GRAPHQL)
        .bearer_auth(token)
        .json(&json!({ "query": query, "variables": variables }))
        .send()
        .await
        .map_err(|_| Error::LinearApi("could not reach Linear".into()))?
        .error_for_status()
        .map_err(|error| {
            Error::LinearApi(format!(
                "Linear returned HTTP {}",
                error.status().unwrap_or_default()
            ))
        })?
        .json::<GraphqlResponse<T>>()
        .await
        .map_err(|_| Error::LinearApi("Linear returned an invalid response".into()))?;

    if !response.errors.is_empty() {
        return Err(Error::LinearApi(response.errors[0].message.clone()));
    }
    response
        .data
        .ok_or_else(|| Error::LinearApi("Linear returned no data".into()))
}
